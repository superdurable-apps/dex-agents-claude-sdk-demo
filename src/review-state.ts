// What the tools and the poller share: the review's FlowIDs, its thread and latest draft as the poller Flow holds them,
// and messages to the agent session.

import { setTimeout as sleep } from "node:timers/promises";

import { FlowNotActiveOrNotFoundError, FlowNotFoundError, IdReusePolicy, InitialAttribute, StopType, type Client } from "@superdurable/dex";
import {
  isFinalToolCallStatus,
  outcomeUnknownToolResult,
  readAgentSnapshot,
  sendAgentUserMessage,
  type AgentFrameworkRunner,
  type AgentMessage,
  type AgentToolCallRecord,
  type AgentSessionFlow,
  type AgentSnapshot,
  type DeferredToolOutcome,
} from "@superdurable/dex-agents";

import { latestDraft, reviewThread, type Draft, type ReviewThread, type SignupReviewThreadPoller } from "./review-thread-poller.js";

/** An agent session Flow of either harness. */
export type ReviewSessionFlow = AgentSessionFlow<AgentFrameworkRunner<DeferredToolOutcome>>;

export const reviewSessionId = (accountId: string): string => `signup-review-${accountId}`;
export const reviewPollerId = (accountId: string): string => `signup-review-${accountId}-poller`;
export const accountIdOf = (sessionId: string): string => sessionId.replace(/^signup-review-/, "");

/** Prefix of the tools' own refusals: nothing was sent. */
export const refusedPrefix = "refused: ";

export interface ReviewerReply {
  readonly ts: string;
  readonly userId: string;
  readonly text: string;
}

/** What the poller holds for the tools: absent until post_review started it. */
export interface ReviewRecord {
  readonly thread: ReviewThread | undefined;
  readonly latestDraft: Draft | undefined;
}

const isMissing = (error: unknown) => error instanceof FlowNotFoundError || error instanceof FlowNotActiveOrNotFoundError;

/** Reads and starts review pollers and sends sessions messages. Connect it once the Client and the Flows exist. */
export class ReviewSessions {
  private connected: { client: Client; sessionFlow: ReviewSessionFlow; pollerFlow: SignupReviewThreadPoller } | undefined;

  public constructor(public readonly reviewerIds: ReadonlySet<string>) {}

  public connect(client: Client, sessionFlow: ReviewSessionFlow, pollerFlow: SignupReviewThreadPoller): void {
    this.connected = { client, sessionFlow, pollerFlow };
  }

  private get dex() {
    if (this.connected === undefined) {
      throw new Error("ReviewSessions is not connected yet");
    }
    return this.connected;
  }

  /** The review's thread and latest draft from its poller; empty when no review post succeeded yet. */
  public async read(accountId: string): Promise<ReviewRecord> {
    try {
      const [thread, draft] = await this.dex.client.getAttributes(reviewPollerId(accountId), reviewThread, latestDraft);
      return { thread, latestDraft: draft };
    } catch (error: unknown) {
      if (isMissing(error)) {
        return { thread: undefined, latestDraft: undefined };
      }
      throw error;
    }
  }

  /**
   * Starts the review's poller with its thread and draft 1, after the review post went out. The Request ID comes from
   * the account, so a repeated start joins the same run; a passing Dex failure is tried again a few times, since a
   * posted review without a poller hears no reviewer.
   */
  public async startPoller(accountId: string, thread: ReviewThread, draft: Draft): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.dex.client.startFlow(this.dex.pollerFlow, reviewPollerId(accountId), { accountId }, {
          requestId: `${accountId}-poller`,
          ignoreAlreadyStarted: true,
          idReusePolicy: IdReusePolicy.DISALLOW,
          attributes: [InitialAttribute.of(reviewThread, thread), InitialAttribute.of(latestDraft, draft)],
        });
        return;
      } catch (error: unknown) {
        if (attempt >= 4) {
          throw error;
        }
        await sleep(250 * 2 ** attempt);
      }
    }
  }

  /** Records the draft post_draft posted as the latest one. */
  public async recordDraft(accountId: string, draft: Draft): Promise<void> {
    await this.dex.client.invokeRPC(this.dex.pollerFlow.recordDraft, reviewPollerId(accountId), draft);
  }

  /**
   * Ends the review: cancels its session, which never ends on its own; the poller sees that and completes. finish_review
   * calls it as its last act, so cancelling the session's own running tool Step loses nothing.
   */
  public async endSession(accountId: string, reason: string): Promise<void> {
    await this.dex.client.stopFlow(reviewSessionId(accountId), { type: StopType.CANCEL, reason }).catch((error: unknown) => {
      if (!isMissing(error)) {
        throw error;
      }
    });
  }

  public snapshot(accountId: string): Promise<AgentSnapshot> {
    return readAgentSnapshot(this.dex.client, this.dex.sessionFlow, reviewSessionId(accountId));
  }

  /** The session's snapshot and its stored messages, oldest first: the snapshot's window and up to 50 pages of 200 before it. */
  public async history(accountId: string): Promise<{ snapshot: AgentSnapshot; messages: AgentMessage[] }> {
    const { client, sessionFlow } = this.dex;
    const sessionId = reviewSessionId(accountId);
    const snapshot = await readAgentSnapshot(client, sessionFlow, sessionId);
    let messages: AgentMessage[] = [...snapshot.messages];
    for (let page = 0; page < 50 && (messages[0]?.sequence ?? 1) > 1; page++) {
      const older = await client.invokeRPC(sessionFlow.listAgentMessages, sessionId, { beforeSequence: messages[0]!.sequence, limit: 200 });
      if (older.messages.length === 0) {
        break;
      }
      messages = [...older.messages, ...messages];
    }
    return { snapshot, messages };
  }

  /**
   * The session's own record of its tool calls: the stored tool results and turn notes, and the finished calls of
   * the running turn. It lives in the session Flow, so time travel of the session rewinds it.
   */
  public async toolRecords(accountId: string): Promise<ToolRecord[]> {
    const { snapshot, messages } = await this.history(accountId);
    return toolRecordsOf(messages, snapshot.toolCalls);
  }

  /**
   * Sends `[retry turn-<n>]` for `turnId` if, read again now, the session's latest turn is still that failed turn and
   * its retry is due. The check and the send are not atomic; sendOnce's marker check narrows the rest.
   * @returns Whether it sent the retry.
   */
  public async retryFailedTurn(accountId: string, turnId: string, firstDelayMs?: number): Promise<boolean> {
    const failed = failedTurnOf(await this.snapshot(accountId), firstDelayMs);
    if (failed?.turnId !== turnId || Date.now() < failed.dueAt) {
      return false;
    }
    await this.sendOnce(accountId, failed.marker, failed.text);
    return true;
  }

  /** Sends `<marker> <text>` unless the session already holds or queues a message that starts with `marker`. */
  public async sendOnce(accountId: string, marker: string, text: string): Promise<void> {
    const { client, sessionFlow } = this.dex;
    const sessionId = reviewSessionId(accountId);
    const { snapshot, messages } = await this.history(accountId);
    const isThere =
      messages.some((message) => message.role === "user" && (message.text ?? "").startsWith(marker)) ||
      (snapshot.queuedMessages ?? []).some((pending) => pending.message.text.startsWith(marker));
    if (!isThere) {
      await sendAgentUserMessage(client, sessionFlow, sessionId, { text: `${marker} ${text}` });
    }
  }
}

/** The first retry of a failed turn waits this long; each later one twice as long, up to {@link maxRetryDelayMs}. */
export const firstRetryDelayMs = 2 * 60_000;
export const maxRetryDelayMs = 30 * 60_000;
/** Starts every retry message: `[retry turn-<n>]`, with the failed turn's ID. */
export const retryMarkerPrefix = "[retry ";

/** A failed turn of an idle session, and when and how to retry it. */
export interface FailedTurn {
  /** The failed turn, `turn-<n>`. */
  readonly turnId: string;
  /** Its error, short and on one line. */
  readonly error: string;
  /** Retries already sent since the message whose turn first failed: 0 for a fresh failure. */
  readonly retries: number;
  /** When the next retry is due, in epoch milliseconds. */
  readonly dueAt: number;
  /** The retry message's marker, unique per failed turn, and the text after it. */
  readonly marker: string;
  readonly text: string;
}

/**
 * The latest turn of an idle session if it failed, or `undefined`. A turn that ends well clears `lastTurnError`, and
 * a queued message starts a turn anyway, so neither counts. The back-off keeps no state of its own: the retries are
 * the retry messages after the message whose turn first failed, and the wait counts from the newest stored message.
 */
export function failedTurnOf(snapshot: AgentSnapshot, firstDelayMs = firstRetryDelayMs): FailedTurn | undefined {
  const state = snapshot.state;
  if (state?.status !== "waiting_for_user_message" || !state.lastTurnError || snapshot.queuedMessageCount > 0 || state.turnCount < 1) {
    return undefined;
  }
  const users = snapshot.messages.filter((message) => message.role === "user" && message.origin === undefined);
  const isRetry = (message: AgentMessage) => (message.text ?? "").startsWith(retryMarkerPrefix);
  const original = [...users].reverse().find((message) => !isRetry(message));
  const retries = users.filter((message) => isRetry(message) && message.sequence > (original?.sequence ?? 0)).length;
  // Once the original has left the snapshot's window, the latest retry still quotes it.
  const latestRetry = [...users].reverse().find(isRetry);
  const originalText = original?.text ?? quotedByRetry(latestRetry?.text ?? "");
  const newest = snapshot.messages.at(-1);
  const since = newest === undefined ? Date.now() : Date.parse(newest.createdAt);
  const turnId = `turn-${state.turnCount}`;
  const error = state.lastTurnError.replace(/\s+/g, " ").trim().slice(0, 200);
  // The failed turn's message is quoted, since a harness may not have kept a turn that failed.
  const quoted = originalText.slice(0, 4_000);
  return {
    turnId,
    error,
    retries,
    dueAt: since + Math.min(firstDelayMs * 2 ** retries, maxRetryDelayMs),
    marker: `${retryMarkerPrefix}${turnId}]`,
    text: `The previous turn failed (${error}). Handle this message again as new, then continue the review from where you left off:\n${quoted}`,
  };
}

/** The message a retry message quotes: everything after its first line. */
export const quotedByRetry = (text: string): string => (text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : "");

/** One tool call as the session itself recorded it, in the order the session stored it. */
export interface ToolRecord {
  /** The bare tool name, such as `send_welcome_email`. */
  readonly tool: string;
  /** `succeeded`, `failed` (nothing happened), or `unknown` (it may have happened). */
  readonly outcome: "succeeded" | "failed" | "unknown";
  readonly output: string;
  /** Where the session stored it: a message sequence, or after every stored message for the running turn. */
  readonly position: number;
}

const bareToolName = (name: string | null | undefined) => (name ?? "").split("__").at(-1)!.split(".").at(-1)!;
/** A tool result that proves nothing happened: the tools' refusals and definite failures. */
const isDefiniteFailure = (output: string) => /^The tool call failed: |refused: |nothing was sent|^not sent: |^invalid arguments|returned providerRejected|failed: /.test(output);
const isUnknownOutcome = (output: string) => output === outcomeUnknownToolResult || /outcome (is )?unknown/i.test(output);
const outcomeOfResult = (output: string): ToolRecord["outcome"] => (isUnknownOutcome(output) ? "unknown" : isDefiniteFailure(output) ? "failed" : "succeeded");
const outcomeOfStatus = (status: string): ToolRecord["outcome"] => (status === "succeeded" ? "succeeded" : status === "outcome_unknown" ? "unknown" : "failed");
/** The turn notes the session writes itself, one line per tool call: `- <tool> <arguments> -> <status>: <outcome>`. */
const noteOrigins = new Set(["turn_failure_note", "turn_steered_note", "turn_cancelled_note"]);
const noteLine = /^- (\S+) .*? -> (succeeded|failed|rejected|outcome_unknown): (.*)$/;

/**
 * The tool calls the session recorded: stored tool results, the session's own turn notes (a failed turn's calls are
 * listed only there), and the finished calls of the running turn. Text the model or a user wrote never counts: a
 * note counts only with the origin the session sets.
 */
export function toolRecordsOf(messages: readonly AgentMessage[], activeToolCalls: readonly AgentToolCallRecord[]): ToolRecord[] {
  const records: ToolRecord[] = [];
  for (const message of messages) {
    if (message.role === "tool" && message.toolName) {
      const output = message.toolOutput ?? message.text ?? "";
      records.push({ tool: bareToolName(message.toolName), outcome: outcomeOfResult(output), output, position: message.sequence });
    } else if (message.role === "user" && message.origin !== undefined && noteOrigins.has(message.origin)) {
      for (const line of (message.text ?? "").split("\n")) {
        const match = noteLine.exec(line);
        if (match !== null) {
          records.push({ tool: bareToolName(match[1]), outcome: outcomeOfStatus(match[2]!), output: match[3]!, position: message.sequence });
        }
      }
    }
  }
  const after = (messages.at(-1)?.sequence ?? 0) + 1;
  for (const call of [...activeToolCalls].sort((left, right) => left.deferralOrder - right.deferralOrder)) {
    if (isFinalToolCallStatus(call.status)) {
      records.push({ tool: bareToolName(call.toolName), outcome: outcomeOfStatus(call.status), output: call.output ?? call.error ?? "", position: after + call.deferralOrder / 1e6 });
    }
  }
  return records;
}

/**
 * Whether the session already sent, or may have sent, the welcome email for draft `draftNumber`: a send that did not
 * definitely fail, recorded after the call that posted that draft. Without that call in the records, any such send
 * counts.
 */
export function wasDraftSent(records: readonly ToolRecord[], draftNumber: number): boolean {
  const posted = records.filter(
    (record) => (record.tool === "post_review" || record.tool === "post_draft") && record.outcome === "succeeded" && record.output.includes(`"draft":{"number":${draftNumber}}`),
  );
  const since = posted.at(-1)?.position ?? Number.NEGATIVE_INFINITY;
  return records.some((record) => record.tool === "send_welcome_email" && record.outcome !== "failed" && record.position > since);
}

/** The output of the session's latest succeeded call of `tool`, or `undefined`. */
export const succeededOutput = (records: readonly ToolRecord[], tool: string): string | undefined =>
  records.filter((record) => record.tool === tool && record.outcome === "succeeded").at(-1)?.output;

/** Whether Slack timestamp `ts` is later than `other`, compared exactly (`<seconds>.<microseconds>`). */
export function isLater(ts: string, other: string): boolean {
  const exact = (value: string): bigint => {
    const [seconds = "0", fraction = ""] = value.split(".");
    return BigInt(seconds) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
  };
  return exact(ts) > exact(other);
}
