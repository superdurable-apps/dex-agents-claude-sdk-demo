// SignupReviewThreadPoller (FlowID `signup-review-<accountId>-poller`): reads the review's Slack thread every minute and
// sends each new reply of a listed reviewer to the agent session, which decides what to do with it. post_review starts it
// with the thread. The polling exists only until the TypeScript Slack connector has a thread-reply Trigger
// (dex-connectors-library#720): Slack calls belong in a Step.

import { setTimeout as sleep } from "node:timers/promises";

import { createCall, RetryError, runMutation, runQuery, throwDexRetry } from "@superdurable/connectors-sdk";
import type { Connection as SlackConnection } from "@superdurable/connector-slack";
import {
  Attribute,
  DexServiceError,
  ExecuteFailure,
  FlowNotActiveOrNotFoundError,
  FlowNotFoundError,
  StepList,
  StopType,
  declareRPCMethod,
  gracefulComplete,
  goTo,
  jsonCodec,
  stringCodec,
  type AsyncContext,
  type Client,
  type Context,
  type Flow,
  type PersistenceSchema,
  type Step,
  type StepDecision,
  type StepOptions,
} from "@superdurable/dex";

import { ReviewApiError, type ReviewApiClient } from "./review-api.js";
import { isLater, reviewSessionId, type ReviewSessions, type ReviewerReply } from "./review-state.js";

export interface PollerInput {
  readonly accountId: string;
}

/** The review's Slack thread: the review post's channel and timestamp, and the Slack app's user that posted it. */
export interface ReviewThread {
  readonly channel: string;
  readonly ts: string;
  readonly botUserId: string;
}

/** The latest email draft posted in the thread, the one send_welcome_email sends. */
export interface Draft {
  readonly number: number;
  readonly subject: string;
  readonly body: string;
}

/** The review thread; post_review sets it when it starts the poller, and nothing changes it. */
export const reviewThread = new Attribute<ReviewThread>("Thread", jsonCodec({ typeName: "ReviewThread" }));
/** The latest posted draft: draft 1 from post_review at the start, then each post_draft through `record_draft`. */
export const latestDraft = new Attribute<Draft>("LatestDraft", jsonCodec({ typeName: "Draft" }));
/** When finish_review ended the review, through `finish`; the poller then stops the session once it is idle. */
export const finishedAt = new Attribute("FinishedAt", stringCodec);
/** The timestamp of the last reply sent to the session. Only WatchThread writes it, before it sends. */
export const threadCursor = new Attribute("Cursor", stringCodec);
/** The Slack page cursor of the newest thread page read; each round reads that one page. */
export const threadPage = new Attribute("ThreadPage", stringCodec);
/** The decision approve_account or reject_account is about to make, through `record_decision`, so the agent's own decision is not reported as one made in Dex Cloud admin. */
export const agentDecision = new Attribute("AgentDecision", stringCodec);
/** The account status already reported to the session as `[dex-cloud <status>]`. */
export const reportedStatus = new Attribute("ReportedStatus", stringCodec);

const heartbeatTimeoutMs = 60_000;
/** At most the heartbeat timeout minus 10 seconds, with a round's 40 seconds included. */
const heartbeatEveryMs = 15_000;

export interface PollerSettings {
  readonly sessions: ReviewSessions;
  readonly slack: SlackConnection;
  readonly reviewApi: ReviewApiClient;
  readonly reviewerSlackIds: ReadonlySet<string>;
  /** Returns the process's Client, which is created after the Registry that holds this Flow. */
  readonly client: () => Client;
  readonly pollIntervalMs?: number;
  /** Every this many rounds the account is read too. */
  readonly accountCheckEveryRounds?: number;
  readonly maxReviewAgeMs?: number;
  /** A round longer than this is abandoned and skipped; 40 seconds by default. */
  readonly roundTimeoutMs?: number;
}

/** Failures that skip one round instead of failing the Step: back-pressure, Dex hiccups, network, a slow round. */
function isTransient(error: unknown, context: AsyncContext): boolean {
  if (context.cancellationSignal.aborted) {
    return false;
  }
  if (error instanceof RetryError) {
    return true;
  }
  if (error instanceof ReviewApiError) {
    return error.httpStatus === 429 || error.httpStatus >= 500;
  }
  if (error instanceof DexServiceError) {
    return [4, 8, 10, 14].includes(Number(error.code)); // DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED, ABORTED, UNAVAILABLE
  }
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError" || /fetch failed/i.test(error.message));
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

async function stopSession(client: Client, sessionId: string, reason: string): Promise<void> {
  await client.stopFlow(sessionId, { type: StopType.CANCEL, reason }).catch((error: unknown) => {
    if (!(error instanceof FlowNotActiveOrNotFoundError)) {
      throw error;
    }
  });
}

/** Rejects with a TimeoutError when `work` takes longer than `ms`; the work itself is abandoned. */
function within<T>(ms: number, work: Promise<T>): Promise<T> {
  return Promise.race([work, sleep(ms).then(() => Promise.reject(new DOMException(`a round took over ${ms} ms`, "TimeoutError")))]);
}

/** What one round found; the Execute applies it, so a round abandoned by its timeout writes nothing. */
type RoundResult =
  | { readonly kind: "idle" }
  | { readonly kind: "complete"; readonly reason: string }
  | { readonly kind: "finished" }
  | { readonly kind: "note"; readonly note: string }
  | { readonly kind: "relay"; readonly fresh: ReviewerReply[]; readonly page: string | undefined }
  | { readonly kind: "page"; readonly page: string }
  | { readonly kind: "report"; readonly status: string };

// dex:group group-id:poll group-label:"Poll"
// dex:explanation text:"Reads the review thread one page a round, picks the new replies of listed reviewers, and ends with the review."
class WatchThread implements Step<PollerInput> {
  private readonly pollIntervalMs: number;
  private readonly accountCheckEveryRounds: number;
  private readonly maxReviewAgeMs: number;
  private readonly roundTimeoutMs: number;

  public constructor(private readonly settings: PollerSettings) {
    // Slack allows a non-Marketplace app about one conversations.replies call a minute.
    this.pollIntervalMs = settings.pollIntervalMs ?? 60_000;
    this.accountCheckEveryRounds = settings.accountCheckEveryRounds ?? 1;
    this.maxReviewAgeMs = settings.maxReviewAgeMs ?? 7 * 24 * 60 * 60_000;
    this.roundTimeoutMs = settings.roundTimeoutMs ?? 40_000;
  }

  public getStepType(): string {
    return "WatchThread";
  }

  public getStepOptions(): StepOptions {
    const maxWaitMs = this.maxReviewAgeMs + 60 * 60_000;
    // Transient failures stay inside the loop; these attempts are for crashes, then the failure route.
    return {
      executeMethodTimeoutMs: maxWaitMs,
      heartbeatTimeoutMs: heartbeatTimeoutMs,
      executeRetry: { maximumAttempts: 4, totalDurationMs: maxWaitMs },
      executeFailure: ExecuteFailure.proceedTo(PostWatchNote),
    };
  }

  /** Returns after each new batch of replies, so the cursor commits before ForwardReplies sends them. */
  public async execute(context: AsyncContext, input: PollerInput): Promise<StepDecision> {
    let delayMs = this.pollIntervalMs;
    for (let round = 1; ; round++) {
      await context.recordHeartbeat(round);
      let result: RoundResult;
      try {
        result = await within(this.roundTimeoutMs, this.round(context, input, round));
        delayMs = this.pollIntervalMs;
      } catch (error: unknown) {
        if (!isTransient(error, context)) {
          throw error;
        }
        console.warn(`review poller ${context.flowId}: skipped a round: ${describe(error)}`);
        result = { kind: "idle" };
        delayMs = Math.min(delayMs * 2, 5 * 60_000);
      }
      // Each decision is returned directly, so dexcli visualize can read the Step's transitions.
      switch (result.kind) {
        case "idle":
          break;
        case "complete":
          return gracefulComplete(result.reason);
        case "finished":
          await stopSession(this.settings.client(), reviewSessionId(input.accountId), "review finished");
          return gracefulComplete("review finished");
        case "note":
          return goTo(PostWatchNote, { ...input, note: result.note });
        case "relay":
          threadCursor.set(context, result.fresh.at(-1)!.ts);
          if (result.page !== undefined) {
            threadPage.set(context, result.page);
          }
          return goTo(ForwardReplies, { accountId: input.accountId, fresh: result.fresh });
        case "page":
          threadPage.set(context, result.page);
          return goTo(WatchThread, { accountId: input.accountId });
        case "report":
          await this.settings.sessions.sendOnce(input.accountId, `[dex-cloud ${result.status}]`, "The account was decided in Dex Cloud admin.");
          reportedStatus.set(context, result.status);
          return goTo(WatchThread, { accountId: input.accountId });
      }
      // Heartbeats stay well inside the heartbeat timeout, however long the pause.
      for (let slept = 0; slept < delayMs; slept += heartbeatEveryMs) {
        await context.recordHeartbeat(round);
        await sleep(Math.min(heartbeatEveryMs, delayMs - slept), undefined, { signal: context.cancellationSignal });
      }
    }
  }

  /** Reads and decides only; it writes nothing, so a round its timeout abandons leaves no trace. */
  private async round(context: AsyncContext, input: PollerInput, round: number): Promise<RoundResult> {
    const { sessions, reviewApi } = this.settings;
    const client = this.settings.client();
    const sessionId = reviewSessionId(input.accountId);
    const session = await client.describeFlow(sessionId).catch((error: unknown) => {
      if (error instanceof FlowNotFoundError || error instanceof FlowNotActiveOrNotFoundError) {
        return undefined;
      }
      throw error;
    });
    if (session === undefined) {
      return { kind: "complete", reason: "no session" };
    }
    if (session.status === "failed") {
      return { kind: "note", note: "The agent session failed, so this review stops here." };
    }
    if (session.status !== "running") {
      return { kind: "complete", reason: "the session ended" };
    }
    if (Date.now() - session.startedAt.getTime() > this.maxReviewAgeMs) {
      return { kind: "note", note: "No decision arrived within 7 days, so this review stops here." };
    }
    // Read from the server: finish_review's RPC may have written it since this Execute started.
    const { isFinished, decision } = await sessions.read(input.accountId);
    const snapshot = await sessions.snapshot(input.accountId);
    if (isFinished &&snapshot.state?.status === "waiting_for_user_message" && snapshot.queuedMessageCount === 0) {
      return { kind: "finished" };
    }
    if (snapshot.state?.status === "failed") {
      return { kind: "note", note: `The agent session failed (${(snapshot.state.lastTurnError ?? "no detail").slice(0, 200)}), so this review stops here.` };
    }
    const thread = reviewThread.get(context);
    if (thread !== undefined) {
      const { messages, nextCursor } = await this.readThreadPage(context, thread, threadPage.get(context));
      const after = threadCursor.get(context) ?? thread.ts;
      const fresh = messages
        .filter((message) => isLater(message.timestamp, after) && message.userId !== undefined && message.userId !== thread.botUserId)
        .filter((message) => this.settings.reviewerSlackIds.has(message.userId!))
        .map((message) => ({ ts: message.timestamp, userId: message.userId!, text: message.text.trim() }));
      // A page with a next page is full: the next round reads the next one. The last page is read again for new replies.
      if (fresh.length > 0) {
        return { kind: "relay", fresh, page: nextCursor };
      }
      if (nextCursor !== undefined) {
        return { kind: "page", page: nextCursor };
      }
    }
    if (!isFinished && round % this.accountCheckEveryRounds === 0 && reportedStatus.get(context) === undefined) {
      const account = await reviewApi.getAccount(input.accountId, AbortSignal.timeout(20_000));
      // A status the agent's own decision explains was not made in Dex Cloud admin.
      const isOwnDecision = (decision === "approve" && account.status === "active") || (decision === "reject" && account.status === "rejected");
      if (account.status !== "pending_approval" && !isOwnDecision) {
        return { kind: "report", status: account.status };
      }
    }
    return { kind: "idle" };
  }

  /** One page of the thread (15 messages), at `page` or from the start, read with the Slack connector inside this Step. */
  private async readThreadPage(context: AsyncContext, thread: ReviewThread, page: string | undefined) {
    const operation = this.settings.slack.operations.listThreadMessages();
    const call = createCall(context, this.settings.slack.reference, operation.definition().operation);
    const result = await runQuery(operation, call, { channelId: thread.channel, threadTimestamp: thread.ts, pageSize: 15, ...(page ? { cursor: page } : {}) });
    if (result.branch !== "read") {
      throw new Error(`reading the Slack thread ended ${result.branch}: ${result.failure?.message ?? ""}`);
    }
    return { messages: result.value.messages ?? [], nextCursor: result.value.nextCursor || undefined };
  }
}

// dex:group group-id:poll group-label:"Poll"
// dex:explanation text:"Sends each new reviewer reply to the agent session, unless the session already holds it."
class ForwardReplies implements Step<{ accountId: string; fresh: ReviewerReply[] }> {
  public constructor(private readonly settings: PollerSettings) {}

  public getStepType(): string {
    return "ForwardReplies";
  }

  public getStepOptions(): StepOptions {
    return { executeRetry: { maximumAttempts: 10, totalDurationMs: 60 * 60_000 }, executeFailure: ExecuteFailure.proceedTo(PostWatchNote) };
  }

  public async execute(_context: AsyncContext, input: { accountId: string; fresh: ReviewerReply[] }): Promise<StepDecision> {
    for (const reply of input.fresh) {
      await this.settings.sessions.sendOnce(input.accountId, `[slack ${reply.ts}]`, `<@${reply.userId}>: ${reply.text}`);
    }
    return goTo(WatchThread, { accountId: input.accountId });
  }
}

// dex:group group-id:poll group-label:"Poll"
// dex:explanation text:"Stops the agent session, says why in the thread, and completes."
class PostWatchNote implements Step<PollerInput & { note?: string }> {
  public constructor(private readonly settings: PollerSettings) {}

  public getStepType(): string {
    return "PostWatchNote";
  }

  public getStepOptions(): StepOptions {
    return { executeDurability: "sync", executeRetry: { maximumAttempts: 3, totalDurationMs: 10 * 60_000 } };
  }

  public async execute(context: AsyncContext, input: PollerInput & { note?: string }): Promise<StepDecision> {
    const note = input.note ?? `The poller of this review failed (${(context.recoveryError?.detail ?? "unknown").slice(0, 200)}), so this review stops here.`;
    await stopSession(this.settings.client(), reviewSessionId(input.accountId), note);
    try {
      const thread = reviewThread.get(context);
      if (thread !== undefined) {
        const operation = this.settings.slack.operations.postThreadReply();
        const call = createCall(context, this.settings.slack.reference, operation.definition().operation);
        await runMutation(operation, call, { channelId: thread.channel, threadTimestamp: thread.ts, text: `${note} Decide on the account in Dex Cloud admin.` }).catch(throwDexRetry);
      }
    } catch (error: unknown) {
      // The note is best effort: the session is stopped already, and a lasting Slack failure must not loop.
      if (context.attempt < 3) {
        throw error;
      }
      console.warn(`review poller ${context.flowId}: the closing note was not posted: ${describe(error)}`);
    }
    return gracefulComplete(note);
  }
}

export class SignupReviewThreadPoller implements Flow<PollerInput> {
  private readonly watchThread: WatchThread;
  private readonly forwardReplies: ForwardReplies;
  private readonly postWatchNote: PostWatchNote;

  public constructor(settings: PollerSettings) {
    this.watchThread = new WatchThread(settings);
    this.forwardReplies = new ForwardReplies(settings);
    this.postWatchNote = new PostWatchNote(settings);
  }

  public getFlowType(): string {
    return "SignupReviewThreadPoller";
  }

  public getSteps(): StepList<PollerInput> {
    return StepList.startStep(this.watchThread).otherSteps(this.forwardReplies, this.postWatchNote);
  }

  public getPersistenceSchema(): PersistenceSchema {
    return { attributes: [reviewThread, latestDraft, finishedAt, threadCursor, threadPage, agentDecision, reportedStatus] };
  }

  /** post_draft records the draft it posted, so send_welcome_email sends what the reviewers saw. Only this RPC writes it after the start. */
  public recordDraft(context: Context, draft: Draft): void {
    latestDraft.set(context, draft);
  }

  /** approve_account and reject_account record their decision before they make it; only this RPC writes it. */
  public recordDecision(context: Context, decision: string): void {
    agentDecision.set(context, decision);
  }

  /** finish_review marks the review finished; only this RPC writes it. */
  public finish(context: Context): void {
    if (finishedAt.get(context) === undefined) {
      finishedAt.set(context, new Date().toISOString());
    }
  }
}

declareRPCMethod(SignupReviewThreadPoller, "recordDraft", { name: "record_draft" });
declareRPCMethod(SignupReviewThreadPoller, "recordDecision", { name: "record_decision" });
declareRPCMethod(SignupReviewThreadPoller, "finish", { name: "finish" });
