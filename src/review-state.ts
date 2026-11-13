// What a review session has done so far, read from its own Dex state: the facts every guard decides from.
// Reviewer replies are the `[slack <ts>] <@user>: text` user messages that the thread-watch Flow sends; tool output
// is never a user message, so nothing a tool returns can pass for a reviewer.

import type { Client } from "@superdurable/dex";
import {
  readAgentSnapshot,
  sendAgentUserMessage,
  toolCallNotRunErrorPrefix,
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
export const accountIdOf = (sessionId: string): string => sessionId.replace(/^signup-review-/, "");

/** Prefixes of the tools' own failures that prove nothing was sent. */
export const refusedPrefix = "refused: ";
export const notSentPrefix = "not sent: ";

export interface Draft {
  readonly subject: string;
  readonly body: string;
  /** Slack timestamp of the post that showed this draft. */
  readonly ts: string;
}

export interface ReviewerReply {
  readonly ts: string;
  readonly userId: string;
  readonly text: string;
}

/** The facts of one review session. */
export interface ReviewState {
  readonly snapshot: AgentSnapshot;
  /** When the session started, from its first message (RFC 3339). */
  readonly startedAt: string;
  /** Whether an earlier post_review may have posted without a confirmation. */
  readonly hasUnconfirmedReviewPost: boolean;
  /** The review's Slack thread, once post_review succeeded, and the bot user that posted it. */
  readonly thread?: { readonly channel: string; readonly ts: string; readonly botUserId: string | undefined };
  /** The newest draft whose post succeeded; draft 1 is in the review post. */
  readonly latestDraft?: Draft;
  /** Drafts whose post may have gone out: the review post and every post_draft that got past its guard. */
  readonly draftAttempts: number;
  /** Whether a post_draft newer than the latest draft may have been posted without a confirmation. */
  readonly hasUnconfirmedNewerDraft: boolean;
  /** The reviewers' replies relayed so far, oldest first. */
  readonly replies: readonly ReviewerReply[];
  /** The latest reply that is a decision: exactly `approve`, or `reject <reason>`. */
  readonly decision?: "approve" | "reject";
  readonly isApprovedHere: boolean;
  readonly isRejectedHere: boolean;
  /** Whether send_welcome_email ever got past its guard, whatever its outcome: it never runs twice. */
  readonly hasSendAttempt: boolean;
  readonly isFinished: boolean;
}

type Outcome = "running" | "succeeded" | "refused" | "unknown";

interface ToolCallFact {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly output: Record<string, unknown> | undefined;
  readonly outcome: Outcome;
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
function outcomeOf(name: string, resultText: string, isSuccess: boolean): Outcome {
  if (isSuccess) {
    return "succeeded";
  }
  const detail = resultText.replace(/^The tool call failed: /, "");
  const isNotRun =
    detail.startsWith(refusedPrefix) ||
    detail.startsWith(notSentPrefix) ||
    detail.startsWith(toolCallNotRunErrorPrefix) ||
    (name === "send_welcome_email" && detail.startsWith(`gmail sendMessage ${connectorNotSentRetryLater}`)) ||
    detail.startsWith(`slack postThreadReply ${connectorNotSentRetryLater}`) ||
    detail.startsWith(`slack postChannelMessage ${connectorNotSentRetryLater}`);
  return isNotRun ? "refused" : "unknown";
}

/** Every tool call: from the stored messages of finished turns, then the active turn's call records. */
function toolCallsOf(messages: readonly AgentMessage[], snapshot: AgentSnapshot): ToolCallFact[] {
  const bareName = (name: string) => name.split("__").at(-1) ?? name;
  const results = new Map(messages.filter((message) => message.role === "tool").map((message) => [message.toolCallId, message.toolOutput]));
  const facts = new Map<string, ToolCallFact>();
  for (const message of messages) {
    if (message.role === "assistant" && message.toolName !== null && message.toolCallId !== null) {
      const resultText = results.get(message.toolCallId);
      const output = parseObject(resultText);
      facts.set(message.toolCallId, {
        name: bareName(message.toolName),
        arguments: parseObject(message.toolArguments) ?? {},
        output,
        outcome: resultText === undefined || resultText === null ? "running" : outcomeOf(bareName(message.toolName), resultText, output !== undefined),
      });
    }
  }
  for (const record of snapshot.toolCalls) {
    const name = bareName(record.toolName);
    const output = record.status === "succeeded" ? parseObject(record.output) : undefined;
    const outcome: Outcome =
      record.status === "succeeded"
        ? "succeeded"
        : record.status === "failed" || record.status === "rejected"
          ? outcomeOf(name, record.error ?? record.rejectionMessage ?? "", false)
          : record.status === "outcome_unknown"
            ? "unknown"
            : "running";
    facts.set(record.toolCallId, { name, arguments: parseObject(record.arguments) ?? {}, output, outcome });
  }
  return [...facts.values()];
}

const replyPattern = /^\[slack (\d+\.\d+)\] <@([A-Z0-9]+)>: ([\s\S]*)$/;

/** Reads review sessions and sends them messages. Connect it once the Client and the session Flow exist. */
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

  public async read(sessionId: string): Promise<ReviewState> {
    const snapshot = await readAgentSnapshot(this.dex.client, this.dex.flow, sessionId);
    const messages = await this.allMessages(sessionId, snapshot);
    const calls = toolCallsOf(messages, snapshot);
    const succeeded = (name: string) => calls.filter((call) => call.name === name && call.outcome === "succeeded");

    const review = succeeded("post_review")[0];
    const reviewMessage = review?.output?.message as { channelId?: string; timestamp?: string; userId?: string } | undefined;
    let latestDraft: Draft | undefined;
    let draftAttempts = review === undefined ? 0 : 1;
    let hasUnconfirmedNewerDraft = false;
    if (review !== undefined && reviewMessage?.timestamp) {
      latestDraft = { subject: String(review.arguments.emailSubject), body: String(review.arguments.emailBody), ts: reviewMessage.timestamp };
    }
    for (const call of calls.filter((candidate) => candidate.name === "post_draft")) {
      if (call.outcome === "succeeded") {
        const ts = String((call.output?.message as { timestamp?: string } | undefined)?.timestamp ?? "");
        latestDraft = { subject: String(call.arguments.subject), body: String(call.arguments.body), ts };
        hasUnconfirmedNewerDraft = false;
      } else if (call.outcome === "unknown") {
        hasUnconfirmedNewerDraft = true;
      }
      draftAttempts += call.outcome === "succeeded" || call.outcome === "unknown" ? 1 : 0;
    }

    const replies: ReviewerReply[] = [];
    for (const message of messages) {
      const match = message.role === "user" && message.origin === undefined ? replyPattern.exec(message.text ?? "") : null;
      if (match !== null && this.reviewerIds.has(match[2]!) && match[2] !== reviewMessage?.userId) {
        replies.push({ ts: match[1]!, userId: match[2]!, text: match[3]!.trim() });
      }
    }
    let decision: "approve" | "reject" | undefined;
    for (const reply of replies) {
      decision = /^approve$/i.test(reply.text) ? "approve" : /^reject\s+\S/i.test(reply.text) ? "reject" : decision;
    }
    return {
      snapshot,
      startedAt: messages[0]?.createdAt ?? new Date().toISOString(),
      hasUnconfirmedReviewPost: review === undefined && calls.some((call) => call.name === "post_review" && call.outcome === "unknown"),
      ...(reviewMessage?.timestamp ? { thread: { channel: String(reviewMessage.channelId), ts: reviewMessage.timestamp, botUserId: reviewMessage.userId } } : {}),
      ...(latestDraft === undefined ? {} : { latestDraft }),
      draftAttempts,
      hasUnconfirmedNewerDraft,
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
