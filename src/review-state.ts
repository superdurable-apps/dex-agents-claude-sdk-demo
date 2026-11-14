// What the tools, the watcher and the reply Trigger share: the review's FlowID, its thread and latest draft as the
// session's own tool records hold them, and the index from a review thread to its session.

import { FlowNotActiveOrNotFoundError, FlowNotFoundError, StopType, type Client } from "@superdurable/dex";
import {
  isFinalToolCallStatus,
  outcomeUnknownToolResult,
  readAgentSnapshot,
  type AgentFrameworkRunner,
  type AgentMessage,
  type AgentToolCallRecord,
  type AgentSessionFlow,
  type AgentSnapshot,
  type DeferredToolOutcome,
} from "@superdurable/dex-agents";

/** An agent session Flow of either harness. */
export type ReviewSessionFlow = AgentSessionFlow<AgentFrameworkRunner<DeferredToolOutcome>>;

export const reviewSessionId = (accountId: string): string => `signup-review-${accountId}`;
export const accountIdOf = (sessionId: string): string => sessionId.replace(/^signup-review-/, "");

/** Prefix of the tools' own refusals: nothing was sent. */
export const refusedPrefix = "refused: ";

/** The review's Slack thread in the review channel: the review post's timestamp. */
export interface ReviewThread {
  readonly ts: string;
}

/** An email draft posted in the thread; the latest one is what send_welcome_email sends. */
export interface Draft {
  readonly number: number;
  readonly subject: string;
  readonly body: string;
}

/** What the session's own tool records say about its review post and drafts. */
export interface ReviewRecord {
  /** The thread of the succeeded post_review, or `undefined` before it. */
  readonly thread: ReviewThread | undefined;
  /** The latest draft a succeeded post_review or post_draft posted, from a stored result or the running turn. */
  readonly latestDraft: Draft | undefined;
  /** Whether a post_review may have posted the review: one did not definitely fail, or the history read is incomplete. */
  readonly isReviewPosted: boolean;
  readonly history: ToolHistory;
}

/** A JSON object, or `undefined`. */
const objectOf = (text: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};
const threadOf = (output: string): ReviewThread | undefined => {
  const thread = objectOf(output)?.thread as { ts?: unknown } | undefined;
  return typeof thread?.ts === "string" && /^\d+\.\d+$/.test(thread.ts) ? { ts: thread.ts } : undefined;
};
const draftOf = (output: string): Draft | undefined => {
  const value = objectOf(output);
  const draft = value?.draft as { number?: unknown } | undefined;
  const email = value?.email as { subject?: unknown; body?: unknown } | undefined;
  return typeof draft?.number === "number" && typeof email?.subject === "string" && typeof email.body === "string"
    ? { number: draft.number, subject: email.subject, body: email.body }
    : undefined;
};

/**
 * The review's thread and latest draft from the session's tool records. A draft counts only from a structured record
 * (a stored tool result or the running turn's call record), never from a turn note, whose free text could fake one.
 * The thread may come from a turn note too, since a turn that fails after its post_review keeps that call only in the
 * note; the tools post only in the configured review channel, so a thread read there can at worst name another
 * thread of that channel.
 */
export function reviewRecordOf(history: ToolHistory): ReviewRecord {
  const reviews = history.records.filter((record) => record.tool === "post_review");
  const posted = reviews.filter((record) => record.outcome === "succeeded" && threadOf(record.output) !== undefined);
  const thread = posted.find((record) => record.source !== "note") ?? posted.at(-1);
  const drafts = history.records
    .filter((record) => record.source !== "note" && (record.tool === "post_review" || record.tool === "post_draft") && record.outcome === "succeeded")
    .map((record) => draftOf(record.output))
    .filter((draft) => draft !== undefined);
  return {
    thread: thread === undefined ? undefined : threadOf(thread.output),
    latestDraft: drafts.at(-1),
    isReviewPosted: reviews.some((record) => record.outcome !== "failed") || (!history.isComplete && reviews.length === 0),
    history,
  };
}

const isMissing = (error: unknown) => error instanceof FlowNotFoundError || error instanceof FlowNotActiveOrNotFoundError;

/**
 * Reads review sessions and ends them, and maps a review thread to its session. Connect it once the Client and the
 * session Flow exist.
 */
export class ReviewSessions {
  private connected: { client: Client; sessionFlow: ReviewSessionFlow } | undefined;
  /** Review thread timestamp to account, for this process. A review's thread never changes once posted. */
  private readonly threads = new Map<string, string>();
  private readonly indexedAccounts = new Set<string>();
  private refresh: { readonly startedAt: number; readonly done: Promise<void> } | undefined;

  public connect(client: Client, sessionFlow: ReviewSessionFlow): void {
    this.connected = { client, sessionFlow };
  }

  private get dex() {
    if (this.connected === undefined) {
      throw new Error("ReviewSessions is not connected yet");
    }
    return this.connected;
  }

  /** The review's thread and latest draft, from one read of the session's tool records. */
  public async review(accountId: string): Promise<ReviewRecord> {
    return reviewRecordOf(await this.toolRecords(accountId));
  }

  /** Records which review a thread belongs to; post_review calls it once its post went out. */
  public rememberThread(threadTs: string, accountId: string): void {
    this.threads.set(threadTs, accountId);
    this.indexedAccounts.add(accountId);
  }

  /**
   * The account whose review thread `threadTs` is, or `undefined` when no running review posted it. A thread this
   * process does not know yet is looked up in Dex: the running sessions of the session Flow type and their own
   * records, read by a lookup that started at or after `since`, so it cannot miss a review posted before then. The
   * index is only this process's cache: a restart, or another process such as the hosted web process, rebuilds it
   * the same way. A failed lookup rejects, and the caller tries again later.
   */
  public async accountOfThread(threadTs: string, since: number): Promise<string | undefined> {
    const known = this.threads.get(threadTs);
    if (known !== undefined) {
      return known;
    }
    await this.refreshAfter(since);
    return this.threads.get(threadTs);
  }

  /** Waits for a lookup of the running reviews that started at or after `since`; concurrent callers share one. */
  private async refreshAfter(since: number): Promise<void> {
    for (;;) {
      const current = this.refresh;
      if (current !== undefined && current.startedAt >= since) {
        return current.done;
      }
      if (current !== undefined) {
        await current.done.catch(() => undefined);
        continue;
      }
      const refresh = { startedAt: Date.now(), done: this.indexRunningReviews() };
      this.refresh = refresh;
      void refresh.done
        .catch(() => undefined)
        .finally(() => {
          if (this.refresh === refresh) {
            this.refresh = undefined;
          }
        });
      return refresh.done;
    }
  }

  /** Reads the thread of each running review not indexed yet. */
  private async indexRunningReviews(): Promise<void> {
    const { client, sessionFlow } = this.dex;
    const query = `FlowType = "${sessionFlow.getFlowType()}" AND ExecutionStatus = "Running"`;
    let pageToken = "";
    do {
      const page = await client.searchFlows(query, 100, pageToken);
      for (const entry of page.flows) {
        const accountId = accountIdOf(entry.flowId);
        if (entry.flowId === reviewSessionId(accountId) && !this.indexedAccounts.has(accountId)) {
          const { thread } = await this.review(accountId);
          if (thread !== undefined) {
            this.rememberThread(thread.ts, accountId);
          }
        }
      }
      pageToken = page.nextPageToken;
    } while (pageToken !== "");
  }

  /**
   * Ends the review: cancels its session, which never ends on its own. finish_review calls it as its last act, so
   * cancelling the session's own running tool Step loses nothing.
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
}

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
      // From a note: evidence of a send, a decision's success, which a decision tool checks against the account
      // before it relies on it, and a review post, for its thread only. Never a draft post: a note's free text could
      // fake one after a real send.
      for (const outcome of noteSendEvidence(text)) {
        records.push({ tool: sendTool, outcome, output: "", position: message.sequence, source: "note" });
      }
      for (const entry of noteEntries(text)) {
        if ((entry.tool === "approve_account" || entry.tool === "reject_account" || entry.tool === "post_review") && entry.status !== undefined) {
          records.push({ tool: entry.tool, outcome: outcomeOfStatus(entry.status), output: entry.output.trim(), position: message.sequence, source: "note" });
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
