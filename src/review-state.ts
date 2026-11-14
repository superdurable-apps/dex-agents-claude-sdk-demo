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

  /**
   * The session's snapshot and its stored messages, oldest first: the snapshot's window and up to 50 pages of 200
   * before it. `isComplete` says whether they reach back to the first message; past the page cap, or when older
   * messages are gone, they do not.
   */
  public async history(accountId: string): Promise<{ snapshot: AgentSnapshot; messages: AgentMessage[]; isComplete: boolean }> {
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
    return { snapshot, messages, isComplete: (messages[0]?.sequence ?? 1) <= 1 };
  }

  /**
   * The session's own record of its tool calls: the stored tool results and turn notes, and the finished calls of
   * the running turn. It lives in the session Flow, so time travel of the session rewinds it.
   */
  public async toolRecords(accountId: string): Promise<ToolHistory> {
    const { snapshot, messages, isComplete } = await this.history(accountId);
    return { records: toolRecordsOf(messages, snapshot.toolCalls), isComplete };
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
  /**
   * Where it comes from: a stored tool result, the running turn's call records, or a turn note. A note's outcome
   * texts are free text that can look like more entries, so a note only ever adds evidence of a send.
   */
  readonly source: "result" | "active" | "note";
}

const bareToolName = (name: string | null | undefined) => (name ?? "").split("__").at(-1)!.split(".").at(-1)!;
/**
 * The starts of a stored tool result that prove nothing happened: the framework's text for a failed call, and the
 * tools' own refusals and definite failures. Only the start counts; the same words later are the result's own text.
 */
const definiteFailureStarts = ["The tool call failed: ", "refused: ", "not sent: ", "invalid arguments", "send_welcome_email failed and nothing was sent: "];
const isJsonObject = (output: string): boolean => {
  try {
    const value: unknown = JSON.parse(output);
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
};

/**
 * The outcome of a stored tool result, from its structure first: every tool's success is a JSON object, and no
 * failure text is. Then only exact starts decide: the framework's unknown-outcome text, or a definite failure. Any
 * other text is a failure for most tools, so it never counts as a draft's post or a decision, and a possible send for
 * send_welcome_email.
 */
export function outcomeOfResult(tool: string, output: string): ToolRecord["outcome"] {
  if (isJsonObject(output)) {
    return "succeeded";
  }
  if (output.startsWith(outcomeUnknownToolResult)) {
    return "unknown";
  }
  if (definiteFailureStarts.some((start) => output.startsWith(start))) {
    return "failed";
  }
  return tool === "send_welcome_email" ? "unknown" : "failed";
}
const outcomeOfStatus = (status: string): ToolRecord["outcome"] => (status === "succeeded" ? "succeeded" : status === "outcome_unknown" ? "unknown" : "failed");
/** The turn notes the session writes itself, one entry per tool call: `- <tool> <arguments> -> <status>: <outcome>`. */
const noteOrigins = new Set(["turn_failure_note", "turn_steered_note", "turn_cancelled_note"]);
const noteStatuses = ["succeeded", "failed", "rejected", "outcome_unknown"] as const;

/** The end (exclusive) of the JSON value that starts at `start`, or -1 when none starts there. Strings and nesting count. */
export function jsonValueEnd(text: string, start: number): number {
  const first = text[start];
  let end = -1;
  if (first === "{" || first === "[") {
    let depth = 0;
    for (let index = start; index < text.length && end < 0; index++) {
      const char = text[index];
      if (char === '"') {
        index = stringEnd(text, index) - 1;
        if (index < 0) {
          return -1;
        }
      } else if (char === "{" || char === "[") {
        depth++;
      } else if (char === "}" || char === "]") {
        depth--;
        end = depth === 0 ? index + 1 : -1;
      }
    }
  } else if (first === '"') {
    end = stringEnd(text, start);
  } else {
    end = start + (/^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(start))?.[0].length ?? 0);
  }
  if (end <= start) {
    return -1;
  }
  try {
    JSON.parse(text.slice(start, end));
    return end;
  } catch {
    return -1;
  }
}

/** The end (exclusive) of the JSON string that starts at `start`, or -1. */
function stringEnd(text: string, start: number): number {
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === "\\") {
      index++;
    } else if (text[index] === '"') {
      return index + 1;
    }
  }
  return -1;
}

/**
 * The tool calls of a turn note, read entry by entry from where each entry starts: the tool name, the arguments as
 * one complete JSON value, then exactly ` -> <status>: `. The arguments come first and are scanned whole, so text in
 * them, such as ` -> succeeded: `, never decides a status. An entry that does not read this way gets no status.
 */
export function noteEntries(text: string): NoteEntry[] {
  const found: { start: number; tool: string; status: NoteEntry["status"]; outputStart: number }[] = [];
  // Valid JSON arguments hold no raw newline, so an entry start is never inside them; inside an outcome it can be,
  // which at worst adds an entry, never hides one.
  for (let start = text.indexOf("\n- "); start >= 0; start = text.indexOf("\n- ", start + 1)) {
    const nameEnd = text.indexOf(" ", start + 3);
    const tool = nameEnd < 0 ? "" : text.slice(start + 3, nameEnd);
    if (tool === "" || /\s/.test(tool)) {
      continue;
    }
    const argsEnd = jsonValueEnd(text, nameEnd + 1);
    const status = argsEnd < 0 ? undefined : noteStatuses.find((candidate) => text.startsWith(` -> ${candidate}:`, argsEnd));
    found.push({ start, tool: bareToolName(tool), status, outputStart: status === undefined ? nameEnd : argsEnd + ` -> ${status}: `.length });
  }
  // An entry's outcome runs to the next entry's start, the last one's to the note's last line.
  const footer = text.lastIndexOf("\n");
  return found.map((entry, index) => {
    const until = found[index + 1]?.start ?? footer;
    const end = Math.max(entry.outputStart, until);
    return { tool: entry.tool, status: entry.status, output: text.slice(entry.outputStart, end), start: entry.start, outputStart: entry.outputStart, end };
  });
}

export interface NoteEntry {
  readonly tool: string;
  /** The entry's status, or `undefined` when the entry does not read unambiguously. */
  readonly status: (typeof noteStatuses)[number] | undefined;
  readonly output: string;
  /** Where its `\n- ` starts, where its outcome text starts, and where that ends, in the note. */
  readonly start: number;
  readonly outputStart: number;
  readonly end: number;
}

const sendTool = "send_welcome_email";

/**
 * The evidence of a send in one turn note, as outcomes: each send entry that reads unambiguously, with its status;
 * a send entry that does not, as unknown; and any other mention of the send tool, such as one inside another call's
 * arguments or outcome text, as unknown too. Only a send's own header and outcome text explain a mention.
 */
export function noteSendEvidence(text: string): ToolRecord["outcome"][] {
  const entries = noteEntries(text);
  const sends = entries.filter((entry) => entry.tool === sendTool);
  const evidence = sends.map((entry) => (entry.status === undefined ? "unknown" : outcomeOfStatus(entry.status)));
  const isExplained = (at: number) => sends.some((entry) => (at > entry.start && at < entry.outputStart) || (entry.status !== undefined && at >= entry.outputStart && at < entry.end));
  for (let at = text.indexOf(sendTool); at >= 0; at = text.indexOf(sendTool, at + 1)) {
    if (!isExplained(at)) {
      evidence.push("unknown");
      break;
    }
  }
  return evidence;
}

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
      const tool = bareToolName(message.toolName);
      records.push({ tool, outcome: outcomeOfResult(tool, output), output, position: message.sequence, source: "result" });
    } else if (message.role === "user" && message.origin !== undefined && noteOrigins.has(message.origin)) {
      const text = message.text ?? "";
      // From a note: evidence of a send, and a decision's success, which a decision tool checks against the account
      // before it relies on it. Never a draft post: a note's free text could fake one after a real send.
      for (const outcome of noteSendEvidence(text)) {
        records.push({ tool: sendTool, outcome, output: "", position: message.sequence, source: "note" });
      }
      for (const entry of noteEntries(text)) {
        if ((entry.tool === "approve_account" || entry.tool === "reject_account") && entry.status !== undefined) {
          records.push({ tool: entry.tool, outcome: outcomeOfStatus(entry.status), output: entry.output, position: message.sequence, source: "note" });
        }
      }
    }
  }
  const after = (messages.at(-1)?.sequence ?? 0) + 1;
  for (const call of [...activeToolCalls].sort((left, right) => left.deferralOrder - right.deferralOrder)) {
    if (isFinalToolCallStatus(call.status)) {
      records.push({ tool: bareToolName(call.toolName), outcome: outcomeOfStatus(call.status), output: call.output ?? call.error ?? "", position: after + call.deferralOrder / 1e6, source: "active" });
    }
  }
  return records;
}

/** The session's tool records, and whether they come from its whole history. */
export interface ToolHistory {
  readonly records: readonly ToolRecord[];
  readonly isComplete: boolean;
}

/**
 * Whether the session already sent, or may have sent, the welcome email for draft `draftNumber`: a send that did not
 * definitely fail, recorded after the call that posted that draft. Without that call in a complete history, any such
 * send counts; without it in an incomplete history, the draft counts as sent, since the part not read may hold it.
 */
export function wasDraftSent(history: ToolHistory, draftNumber: number): boolean {
  const { records, isComplete } = history;
  // A draft's post counts only from a structured record: a stored tool result or the running turn's call record.
  const posted = records.filter(
    (record) =>
      record.source !== "note" &&
      (record.tool === "post_review" || record.tool === "post_draft") &&
      record.outcome === "succeeded" &&
      record.output.includes(`"draft":{"number":${draftNumber}}`),
  );
  if (posted.length === 0 && !isComplete) {
    return true;
  }
  const since = posted.at(-1)?.position ?? Number.NEGATIVE_INFINITY;
  return records.some((record) => record.tool === "send_welcome_email" && record.outcome !== "failed" && record.position > since);
}

/**
 * What a decision tool does with an earlier success of the same decision in this session: return it when the account
 * still shows it; say what changed when the account was decided the other way since; decide again when the account
 * is pending, since then the record does not match the account (a stale read, or text that only looks like a record).
 */
export function earlierDecision(decision: "approve" | "reject", accountStatus: string): "same" | "changed" | "decide" {
  const target = decision === "approve" ? "active" : "rejected";
  return accountStatus === target ? "same" : accountStatus === "pending_approval" ? "decide" : "changed";
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
