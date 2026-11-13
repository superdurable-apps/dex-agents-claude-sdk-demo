// What a review has done so far, read from Dex state: the facts every guard decides from.
// The reviewers' replies come only from the thread-watch Flow's RelayedReplies Attribute: a message that someone sends
// to the session, or text in a tool result, never counts as a reviewer's reply.

import { Attribute, FlowNotActiveOrNotFoundError, jsonCodec, stringCodec, type Client } from "@superdurable/dex";
import {
  readAgentSnapshot,
  sendAgentUserMessage,
  toolCallNotRunErrorPrefix,
  turnFailureNoteHeader,
  type AgentFrameworkRunner,
  type AgentMessage,
  type AgentSessionFlow,
  type AgentSnapshot,
  type DeferredToolOutcome,
} from "@superdurable/dex-agents";
import { connectorNotSentRetryLater } from "@superdurable/dex-agents/connectors";

/** An agent session Flow of either harness. */
export type ReviewSessionFlow = AgentSessionFlow<AgentFrameworkRunner<DeferredToolOutcome>>;

export const reviewSessionId = (accountId: string): string => `signup-review-${accountId}`;
export const threadWatchFlowId = (accountId: string): string => `signup-review-${accountId}-thread`;
export const accountIdOf = (sessionId: string): string => sessionId.replace(/^signup-review-/, "");

/** Prefixes of the tools' own failures that prove nothing was sent. */
export const refusedPrefix = "refused: ";
export const notSentPrefix = "not sent: ";

export interface ReviewerReply {
  readonly ts: string;
  readonly userId: string;
  readonly text: string;
}

/** Thread-watch Flow state: every reviewer reply it relayed, oldest first, recorded before it is forwarded. */
export const relayedReplies = new Attribute<ReviewerReply[]>("RelayedReplies", jsonCodec({ typeName: "ReviewerReplies" }));
/** Thread-watch Flow state: the timestamp of the last relayed reply. */
export const threadCursor = new Attribute("Cursor", stringCodec);

/** A draft as the post that showed it describes it: the write tools return self-describing outputs. */
export interface Draft {
  readonly number: number;
  readonly subject: string;
  readonly body: string;
  readonly ts: string;
}

type Outcome = "running" | "succeeded" | "refused" | "unknown";

/** One tool call of the session, with its outcome and the start time of the turn that asked for it. */
export interface ToolCallFact {
  readonly id: string;
  readonly name: string;
  readonly outcome: Outcome;
  readonly output: Record<string, unknown> | undefined;
  readonly resultText: string | undefined;
  readonly askedAt: string;
}

/** The facts of one review. */
export interface ReviewState {
  readonly snapshot: AgentSnapshot;
  readonly calls: readonly ToolCallFact[];
  /** The review's Slack thread, once post_review succeeded, and the bot user that posted it. */
  readonly thread?: { readonly channel: string; readonly ts: string; readonly botUserId: string | undefined };
  /** The newest draft whose post succeeded. */
  readonly latestDraft?: Draft;
  /** Drafts whose post may have gone out, the review post included. */
  readonly draftAttempts: number;
  readonly hasUnconfirmedNewerDraft: boolean;
  /** The model response time of an earlier post_review that may have posted without a confirmation. */
  readonly unconfirmedReviewPostAt?: string;
  readonly replies: readonly ReviewerReply[];
  /** The latest reply that decides: exactly `approve`, `reject <reason>`, or `hold`, which cancels both. */
  readonly decision?: "approve" | "reject";
  readonly isApprovedHere: boolean;
  readonly isRejectedHere: boolean;
  readonly hasSendAttempt: boolean;
  readonly isFinished: boolean;
}

function parseObject(text: string | null | undefined): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text ?? "");
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** A finished call's outcome from its result text: our refusals and the SDK's not-run notes prove nothing ran. */
function outcomeOf(resultText: string, isSuccess: boolean): Outcome {
  if (isSuccess) {
    return "succeeded";
  }
  const detail = resultText.replace(/^The tool call failed: /, "");
  const isNotRun =
    detail.startsWith(refusedPrefix) ||
    detail.startsWith(notSentPrefix) ||
    detail.startsWith(toolCallNotRunErrorPrefix) ||
    ["gmail sendMessage", "slack postThreadReply", "slack postChannelMessage"].some((operation) => detail.startsWith(`${operation} ${connectorNotSentRetryLater}`)) ||
    // The Claude Code CLI runs one deferred call per turn segment and denies the others before they run.
    /^\S+ did not run(\. It must run outside this turn|: its permission check failed)/.test(detail);
  return isNotRun ? "refused" : "unknown";
}

/** Every tool call a stored model response asked for, found in its framework item: pi-ai `toolCall` and Claude `tool_use` parts. */
function callsIn(message: AgentMessage): { id: string; name: string }[] {
  const found = new Map<string, string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (typeof node === "object" && node !== null) {
      const record = node as Record<string, unknown>;
      if ((record.type === "toolCall" || record.type === "tool_use") && typeof record.id === "string" && typeof record.name === "string") {
        found.set(record.id, record.name);
      }
      Object.values(record).forEach(visit);
    }
  };
  visit(parseObject(message.frameworkItem));
  if (message.toolCallId !== null && message.toolName !== null) {
    found.set(message.toolCallId, message.toolName);
  }
  return [...found].map(([id, name]) => ({ id, name: name.split("__").at(-1) ?? name }));
}

/**
 * Every tool call of the session, in order: from each stored model response, from the active turn's records, and from
 * the notes a failed turn leaves, whose transcript a harness may not keep. A call without a recorded outcome, such
 * as one of a failed turn, counts as unknown: it may have run.
 */
function toolCallsOf(messages: readonly AgentMessage[], snapshot: AgentSnapshot): ToolCallFact[] {
  const results = new Map(messages.filter((message) => message.role === "tool" && message.toolCallId !== null).map((message) => [message.toolCallId!, message.toolOutput ?? ""]));
  const active = new Map(snapshot.toolCalls.map((record) => [record.toolCallId, record]));
  const turnStarts = new Map<string, string>();
  for (const message of messages.filter((candidate) => candidate.role === "user")) {
    turnStarts.set(message.turnId, turnStarts.get(message.turnId) ?? message.createdAt);
  }
  const startOf = (turnId: string) => turnStarts.get(turnId) ?? messages[0]?.createdAt ?? new Date(0).toISOString();
  const facts = new Map<string, ToolCallFact>();
  const add = (id: string, name: string, askedAt: string) => {
    const resultText = results.get(id);
    const record = active.get(id);
    let outcome: Outcome;
    let output: Record<string, unknown> | undefined;
    if (record !== undefined) {
      output = record.status === "succeeded" ? parseObject(record.output) : undefined;
      outcome =
        record.status === "succeeded"
          ? "succeeded"
          : record.status === "failed" || record.status === "rejected"
            ? outcomeOf(record.error ?? record.rejectionMessage ?? "", false)
            : record.status === "outcome_unknown"
              ? "unknown"
              : "running";
    } else if (resultText !== undefined) {
      output = parseObject(resultText);
      outcome = outcomeOf(resultText, output !== undefined);
    } else {
      outcome = "unknown";
    }
    facts.set(id, { id, name, outcome, output, resultText: resultText ?? record?.output ?? record?.error ?? undefined, askedAt });
  };
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of callsIn(message)) {
        add(call.id, call.name, startOf(message.turnId));
      }
    } else if (message.role === "user" && message.origin === "turn_failure_note" && (message.text ?? "").startsWith(turnFailureNoteHeader)) {
      // Lines `- <tool> <arguments> -> <status>: <outcome>`; calls already known from their response are skipped.
      (message.text ?? "").split("\n").forEach((line, index) => {
        const match = /^- (\S+) [\s\S]* -> (\w+): ([\s\S]*)$/.exec(line);
        const name = match?.[1]?.split("__").at(-1);
        if (match === null || name === undefined || [...facts.values()].some((fact) => fact.name === name && fact.askedAt === startOf(message.turnId))) {
          return;
        }
        const output = match[2] === "succeeded" ? parseObject(match[3]) : undefined;
        const outcome: Outcome = match[2] === "succeeded" ? "succeeded" : match[2] === "failed" ? outcomeOf(match[3] ?? "", false) : "unknown";
        facts.set(`${message.sequence}-${index}`, { id: `${message.sequence}-${index}`, name, outcome, output, resultText: match[3], askedAt: startOf(message.turnId) });
      });
    }
  }
  for (const record of snapshot.toolCalls.filter((candidate) => !facts.has(candidate.toolCallId))) {
    add(record.toolCallId, record.toolName.split("__").at(-1) ?? record.toolName, startOf(record.turnId));
  }
  return [...facts.values()];
}

/** Reads reviews and sends their sessions messages. Connect it once the Client and the session Flow exist. */
export class ReviewSessions {
  private client: Client | undefined;
  private flow: ReviewSessionFlow | undefined;

  public constructor(private readonly reviewerIds: ReadonlySet<string>) {}

  public connect(client: Client, flow: ReviewSessionFlow): void {
    this.client = client;
    this.flow = flow;
  }

  private get dex(): { client: Client; flow: ReviewSessionFlow } {
    if (this.client === undefined || this.flow === undefined) {
      throw new Error("ReviewSessions is not connected yet");
    }
    return { client: this.client, flow: this.flow };
  }

  /** Sends `<marker> <text>` unless the session already holds or queues a message that starts with `marker`. */
  public async sendOnce(sessionId: string, marker: string, text: string): Promise<void> {
    const { client, flow } = this.dex;
    const snapshot = await readAgentSnapshot(client, flow, sessionId);
    const messages = await this.allMessages(sessionId, snapshot);
    const isThere =
      messages.some((message) => message.role === "user" && (message.text ?? "").startsWith(marker)) ||
      (snapshot.queuedMessages ?? []).some((pending) => pending.message.text.startsWith(marker));
    if (!isThere) {
      await sendAgentUserMessage(client, flow, sessionId, { text: `${marker} ${text}` });
    }
  }

  /** The reviewer replies the review's thread-watch Flow recorded; none before it exists. */
  public async replies(accountId: string): Promise<ReviewerReply[]> {
    try {
      const [recorded] = await this.dex.client.getAttributes(threadWatchFlowId(accountId), relayedReplies);
      return recorded ?? [];
    } catch (error: unknown) {
      if (error instanceof FlowNotActiveOrNotFoundError) {
        return [];
      }
      throw error;
    }
  }

  public async read(sessionId: string): Promise<ReviewState> {
    const snapshot = await readAgentSnapshot(this.dex.client, this.dex.flow, sessionId);
    const messages = await this.allMessages(sessionId, snapshot);
    const calls = toolCallsOf(messages, snapshot);
    const succeeded = (name: string) => calls.filter((call) => call.name === name && call.outcome === "succeeded");

    const reviewPost = succeeded("post_review")[0];
    const reviewMessage = reviewPost?.output?.message as { channelId?: string; timestamp?: string; userId?: string } | undefined;
    let latestDraft: Draft | undefined;
    let draftAttempts = 0;
    let hasUnconfirmedNewerDraft = false;
    for (const call of calls.filter((candidate) => candidate.name === "post_review" || candidate.name === "post_draft")) {
      if (call.outcome === "succeeded") {
        const draft = call.output?.draft as Omit<Draft, "ts"> | null | undefined;
        const ts = String((call.output?.message as { timestamp?: string } | undefined)?.timestamp ?? "");
        // An adopted review post whose draft is not known shows no usable draft.
        latestDraft = draft ? { ...draft, ts } : call.name === "post_review" ? undefined : latestDraft;
        hasUnconfirmedNewerDraft = false;
      } else if (call.outcome === "unknown" && call.name === "post_draft") {
        hasUnconfirmedNewerDraft = true;
      }
      draftAttempts += call.outcome === "succeeded" || (call.outcome === "unknown" && call.name === "post_draft") ? 1 : 0;
    }

    const replies = (await this.replies(accountIdOf(sessionId))).filter((reply) => this.reviewerIds.has(reply.userId) && reply.userId !== reviewMessage?.userId);
    let decision: "approve" | "reject" | undefined;
    for (const reply of replies) {
      decision = /^approve$/i.test(reply.text) ? "approve" : /^reject\s+\S/i.test(reply.text) ? "reject" : /^hold$/i.test(reply.text) ? undefined : decision;
    }
    const unconfirmedReviewPost = reviewPost === undefined ? calls.find((call) => call.name === "post_review" && call.outcome === "unknown") : undefined;
    return {
      snapshot,
      calls,
      ...(reviewMessage?.timestamp ? { thread: { channel: String(reviewMessage.channelId), ts: reviewMessage.timestamp, botUserId: reviewMessage.userId } } : {}),
      ...(latestDraft === undefined ? {} : { latestDraft }),
      draftAttempts,
      hasUnconfirmedNewerDraft,
      ...(unconfirmedReviewPost === undefined ? {} : { unconfirmedReviewPostAt: unconfirmedReviewPost.askedAt }),
      replies,
      ...(decision === undefined ? {} : { decision }),
      isApprovedHere: succeeded("approve_account").some((call) => call.output?.status === "approved"),
      isRejectedHere: succeeded("reject_account").some((call) => call.output?.status === "rejected"),
      hasSendAttempt: calls.some((call) => call.name === "send_welcome_email" && (call.outcome === "succeeded" || call.outcome === "unknown")),
      isFinished: succeeded("finish_review").length > 0,
    };
  }

  /** All of the session's messages: the snapshot holds the newest 200, and older pages are read back. */
  private async allMessages(sessionId: string, snapshot: AgentSnapshot): Promise<AgentMessage[]> {
    const { client, flow } = this.dex;
    let messages = [...snapshot.messages];
    for (let page = 0; page < 50 && (messages[0]?.sequence ?? 1) > 1; page++) {
      const older = await client.invokeRPC(flow.listAgentMessages, sessionId, { beforeSequence: messages[0]!.sequence, limit: 200 });
      if (older.messages.length === 0) {
        break;
      }
      messages = [...older.messages, ...messages];
    }
    return messages;
  }
}

/** Whether Slack timestamp `ts` is later than `other`, compared exactly (`<seconds>.<microseconds>`). */
export function isLater(ts: string, other: string): boolean {
  const exact = (value: string): bigint => {
    const [seconds = "0", fraction = ""] = value.split(".");
    return BigInt(seconds) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
  };
  return exact(ts) > exact(other);
}
