// SignupReviewLedgerFlow (FlowID `signup-review-<accountId>-ledger`): the review's single authoritative record.
// Its `record_effect` RPC records each external effect before and after a write tool dispatches it, and its polling
// Step relays reviewer replies from Slack to the agent session, recording each one first. The polling exists only until
// the TypeScript Slack connector has a thread-reply Trigger (dex-connectors-library#720): Slack calls belong in a Step.

import { setTimeout as sleep } from "node:timers/promises";

import { createCall, RetryError, runMutation, runQuery, throwDexRetry } from "@superdurable/connectors-sdk";
import type { Connection as SlackConnection, Message as SlackMessage } from "@superdurable/connector-slack";
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
import {
  effects,
  isLater,
  ledgerRestarts,
  relayedReplies,
  reviewSessionId,
  threadCursor,
  threadPage,
  type Effect,
  type ReviewSessions,
  type ReviewerReply,
} from "./review-state.js";

export interface LedgerInput {
  readonly accountId: string;
  /** A restarted ledger forwards its carried replies first; the session skips those it already holds. */
  readonly isRestart?: boolean;
}

/** The account status already reported to the session as `[dex-cloud <status>]`. */
const reportedStatus = new Attribute("ReportedStatus", stringCodec);
export const reportedStatusForTest = reportedStatus;
const maxRecordedReplies = 500;
/** Bounds the Effects Attribute, which holds each posted draft once. */
const maxEffectsBytes = 256 * 1024;
const heartbeatTimeoutMs = 60_000;
/** At most the heartbeat timeout minus 10 seconds, with a round's 40 seconds included. */
const heartbeatEveryMs = 15_000;
/** A ledger that ended this way before its session existed; the watcher cancels such a session. */
export const noSessionStarted = "no session started";
/** Tools whose effect may happen once per review: a second attempt is refused under the ledger's lock. */
const onceOnlyTools = new Set(["post_review", "send_welcome_email"]);

export interface LedgerSettings {
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
  return Promise.race([work, sleep(ms).then(() => Promise.reject(Object.assign(new Error(`a round took over ${ms} ms`), { name: "TimeoutError" })))]);
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

// dex:group group-id:relay group-label:"Relay"
// dex:explanation text:"Polls the review thread one page a round, records new reviewer replies, and ends with the review."
class WatchThread implements Step<LedgerInput> {
  private readonly pollIntervalMs: number;
  private readonly accountCheckEveryRounds: number;
  private readonly maxReviewAgeMs: number;
  private readonly roundTimeoutMs: number;

  public constructor(private readonly settings: LedgerSettings) {
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

  /** Returns after each new batch of replies, so they and the cursors commit before ForwardReplies sends them. */
  public async execute(context: AsyncContext, input: LedgerInput): Promise<StepDecision> {
    if (input.isRestart) {
      return goTo(ForwardReplies, { accountId: input.accountId, fresh: relayedReplies.get(context) ?? [] });
    }
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
        console.warn(`review ledger ${context.flowId}: skipped a round: ${describe(error)}`);
        result = { kind: "idle" };
        delayMs = Math.min(delayMs * 2, 5 * 60_000);
      }
      const decision = await this.apply(context, input, result);
      if (decision !== undefined) {
        return decision;
      }
      // Heartbeats stay well inside the heartbeat timeout, however long the pause.
      for (let slept = 0; slept < delayMs; slept += heartbeatEveryMs) {
        await context.recordHeartbeat(round);
        await sleep(Math.min(heartbeatEveryMs, delayMs - slept), undefined, { signal: context.cancellationSignal });
      }
    }
  }

  /** Writes what a round found: Attributes, the session, and the next Step. */
  private async apply(context: AsyncContext, input: LedgerInput, result: RoundResult): Promise<StepDecision | undefined> {
    const sessionId = reviewSessionId(input.accountId);
    switch (result.kind) {
      case "idle":
        return undefined;
      case "complete":
        return gracefulComplete(result.reason);
      case "finished":
        await stopSession(this.settings.client(), sessionId, "review finished");
        return gracefulComplete("review finished");
      case "note":
        return goTo(PostWatchNote, { ...input, note: result.note });
      case "relay":
        relayedReplies.set(context, [...(relayedReplies.get(context) ?? []), ...result.fresh].slice(-maxRecordedReplies));
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
  }

  /** Reads and decides only; it writes nothing, so a round its timeout abandons leaves no trace. */
  private async round(context: AsyncContext, input: LedgerInput, round: number): Promise<RoundResult> {
    const { sessions, reviewApi } = this.settings;
    const sessionId = reviewSessionId(input.accountId);
    const session = await this.settings
      .client()
      .describeFlow(sessionId)
      .catch((error: unknown) => {
        if (error instanceof FlowNotFoundError || error instanceof FlowNotActiveOrNotFoundError) {
          return undefined;
        }
        throw error;
      });
    if (session === undefined) {
      // The watcher starts the session right after this ledger; until then there is nothing to watch.
      return Date.now() - context.flowStartedAt.getTime() > this.maxReviewAgeMs ? { kind: "complete", reason: noSessionStarted } : { kind: "idle" };
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
    // The ledger's own committed effects: an RPC may have recorded some since this Execute started.
    const state = await sessions.read(input.accountId);
    const snapshot = await sessions.snapshot(input.accountId);
    if (state.isFinished && snapshot.state?.status === "waiting_for_user_message" && snapshot.queuedMessageCount === 0) {
      return { kind: "finished" };
    }
    if (snapshot.state?.status === "failed") {
      return { kind: "note", note: `The agent session failed (${(snapshot.state.lastTurnError ?? "no detail").slice(0, 200)}), so this review stops here.` };
    }
    if (state.thread !== undefined) {
      const page = threadPage.get(context);
      const { messages, nextCursor } = await this.readThreadPage(context, state.thread, page);
      const after = threadCursor.get(context) ?? state.thread.ts;
      const fresh = messages
        .filter((message) => isLater(message.timestamp, after) && message.userId !== undefined && message.userId !== state.thread?.botUserId)
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
    if (round % this.accountCheckEveryRounds === 0 && !state.isApprovedHere && !state.isRejectedHere && reportedStatus.get(context) === undefined) {
      const account = await reviewApi.getAccount(input.accountId, AbortSignal.timeout(20_000));
      // A status the reviewers' own decision explains is this review's decision on its way, not one made elsewhere.
      const isOwnDecision = (state.decision === "approve" && account.status === "active") || (state.decision === "reject" && account.status === "rejected");
      if (account.status !== "pending_approval" && !isOwnDecision) {
        return { kind: "report", status: account.status };
      }
    }
    return { kind: "idle" };
  }

  /** One page of the thread (15 messages), at `page` or from the start, read with the Slack connector inside this Step. */
  private async readThreadPage(context: AsyncContext, thread: { channel: string; ts: string }, page: string | undefined) {
    const operation = this.settings.slack.operations.listThreadMessages();
    const call = createCall(context, this.settings.slack.reference, operation.definition().operation);
    const result = await runQuery(operation, call, { channelId: thread.channel, threadTimestamp: thread.ts, pageSize: 15, ...(page ? { cursor: page } : {}) });
    if (result.branch !== "read") {
      throw new Error(`reading the Slack thread ended ${result.branch}: ${result.failure?.message ?? ""}`);
    }
    return { messages: result.value.messages ?? [], nextCursor: result.value.nextCursor || undefined };
  }
}

// dex:group group-id:relay group-label:"Relay"
// dex:explanation text:"Sends each recorded reply to the agent session once, as its notification."
class ForwardReplies implements Step<{ accountId: string; fresh: ReviewerReply[] }> {
  public constructor(private readonly settings: LedgerSettings) {}

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

// dex:group group-id:relay group-label:"Relay"
// dex:explanation text:"Stops the agent session, says why in the thread, and completes."
class PostWatchNote implements Step<LedgerInput & { note?: string }> {
  public constructor(private readonly settings: LedgerSettings) {}

  public getStepType(): string {
    return "PostWatchNote";
  }

  public getStepOptions(): StepOptions {
    return { executeDurability: "sync", executeRetry: { maximumAttempts: 3, totalDurationMs: 10 * 60_000 } };
  }

  public async execute(context: AsyncContext, input: LedgerInput & { note?: string }): Promise<StepDecision> {
    const note = input.note ?? `The relay of this review failed (${(context.recoveryError?.detail ?? "unknown").slice(0, 200)}), so this review stops here.`;
    await stopSession(this.settings.client(), reviewSessionId(input.accountId), note);
    try {
      const thread = (await this.settings.sessions.read(input.accountId)).thread;
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
      console.warn(`review ledger ${context.flowId}: the closing note was not posted: ${describe(error)}`);
    }
    return gracefulComplete(note);
  }
}

export class SignupReviewLedgerFlow implements Flow<LedgerInput> {
  private readonly watchThread: WatchThread;
  private readonly forwardReplies: ForwardReplies;
  private readonly postWatchNote: PostWatchNote;

  public constructor(settings: LedgerSettings) {
    this.watchThread = new WatchThread(settings);
    this.forwardReplies = new ForwardReplies(settings);
    this.postWatchNote = new PostWatchNote(settings);
  }

  public getFlowType(): string {
    return "SignupReviewLedgerFlow";
  }

  public getSteps(): StepList<LedgerInput> {
    return StepList.startStep(this.watchThread).otherSteps(this.forwardReplies, this.postWatchNote);
  }

  public getPersistenceSchema(): PersistenceSchema {
    return { attributes: [effects, relayedReplies, threadCursor, threadPage, reportedStatus, ledgerRestarts] };
  }

  /**
   * Records one effect under its call key. `attempted` adds the effect once, and is refused for a once-only tool that
   * already has an effect that may have happened; `succeeded` completes an effect; `not_sent` applies only to an
   * attempted one, with the caller's proof. A succeeded effect never changes.
   */
  public recordEffect(context: Context, effect: Omit<Effect, "at">): void {
    const recorded = effects.get(context) ?? [];
    const index = recorded.findIndex((candidate) => candidate.callKey === effect.callKey);
    const existing = index < 0 ? undefined : recorded[index]!;
    if (existing?.status === "succeeded" || (existing !== undefined && effect.status === "attempted")) {
      return;
    }
    if (effect.status === "not_sent" && existing?.status !== "attempted") {
      throw new Error(`not_sent needs an attempted effect for ${effect.callKey}`);
    }
    const mayHaveHappened = (candidate: Effect) => candidate.status === "attempted" || candidate.status === "succeeded";
    if (effect.status === "attempted" && onceOnlyTools.has(effect.tool) && recorded.some((candidate) => candidate.tool === effect.tool && mayHaveHappened(candidate))) {
      throw new Error(`${effect.tool} may already have happened in this review; it happens at most once`);
    }
    const next: Effect = { ...existing, ...effect, at: existing?.at ?? new Date().toISOString() };
    const updated = existing === undefined ? [...recorded, next] : recorded.map((candidate, at) => (at === index ? next : candidate));
    if (JSON.stringify(updated).length > maxEffectsBytes) {
      throw new Error(`the review ledger holds its maximum of ${maxEffectsBytes} bytes of effects`);
    }
    effects.set(context, updated);
  }
}

declareRPCMethod(SignupReviewLedgerFlow, "recordEffect", { name: "record_effect", lockAttributes: [effects.lock()] });
