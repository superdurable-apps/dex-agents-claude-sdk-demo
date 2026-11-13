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
const maxRecordedReplies = 500;
const maxEffects = 500;
const roundTimeoutMs = 40_000;

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

// dex:group group-id:relay group-label:"Relay"
// dex:explanation text:"Polls the review thread, records new reviewer replies, and ends with the review."
class WatchThread implements Step<LedgerInput> {
  private readonly pollIntervalMs: number;
  private readonly accountCheckEveryRounds: number;
  private readonly maxReviewAgeMs: number;

  public constructor(private readonly settings: LedgerSettings) {
    // A round and its sleep stay well inside the one-minute heartbeat timeout.
    this.pollIntervalMs = Math.min(settings.pollIntervalMs ?? 15_000, 40_000);
    this.accountCheckEveryRounds = settings.accountCheckEveryRounds ?? 4;
    this.maxReviewAgeMs = settings.maxReviewAgeMs ?? 7 * 24 * 60 * 60_000;
  }

  public getStepType(): string {
    return "WatchThread";
  }

  public getStepOptions(): StepOptions {
    const maxWaitMs = this.maxReviewAgeMs + 60 * 60_000;
    // Transient failures stay inside the loop; a crash retries until the review's time is up, then the failure route.
    return { executeMethodTimeoutMs: maxWaitMs, heartbeatTimeoutMs: 60_000, executeRetry: { totalDurationMs: maxWaitMs }, executeFailure: ExecuteFailure.proceedTo(PostWatchNote) };
  }

  /** Returns after each new batch of replies, so they and the cursor commit before ForwardReplies sends them. */
  public async execute(context: AsyncContext, input: LedgerInput): Promise<StepDecision> {
    if (input.isRestart) {
      return goTo(ForwardReplies, { accountId: input.accountId, fresh: relayedReplies.get(context) ?? [] });
    }
    let delayMs = this.pollIntervalMs;
    for (let round = 1; ; round++) {
      await context.recordHeartbeat(round);
      try {
        const decision = await within(roundTimeoutMs, this.round(context, input, round));
        if (decision !== undefined) {
          return decision;
        }
        delayMs = this.pollIntervalMs;
      } catch (error: unknown) {
        if (!isTransient(error, context)) {
          throw error;
        }
        console.warn(`review ledger ${context.flowId}: skipped a round: ${describe(error)}`);
        delayMs = Math.min(delayMs * 2, 40_000);
      }
      for (let slept = 0; slept < delayMs; slept += 15_000) {
        await sleep(Math.min(15_000, delayMs - slept), undefined, { signal: context.cancellationSignal });
        await context.recordHeartbeat(round);
      }
    }
  }

  private async round(context: AsyncContext, input: LedgerInput, round: number): Promise<StepDecision | undefined> {
    const { sessions, reviewApi } = this.settings;
    const sessionId = reviewSessionId(input.accountId);
    const client = this.settings.client();
    const session = await client.describeFlow(sessionId).catch((error: unknown) => {
      if (error instanceof FlowNotFoundError || error instanceof FlowNotActiveOrNotFoundError) {
        return undefined;
      }
      throw error;
    });
    if (session === undefined) {
      // The watcher starts the session right after this ledger; until then there is nothing to watch.
      return Date.now() - context.flowStartedAt.getTime() > this.maxReviewAgeMs ? gracefulComplete("no session started") : undefined;
    }
    if (session.status === "failed") {
      return goTo(PostWatchNote, { ...input, note: "The agent session failed, so this review stops here." });
    }
    if (session.status !== "running") {
      return gracefulComplete("the session ended");
    }
    if (Date.now() - session.startedAt.getTime() > this.maxReviewAgeMs) {
      return goTo(PostWatchNote, { ...input, note: "No decision arrived within 7 days, so this review stops here." });
    }
    // The ledger's own committed effects: an RPC may have recorded some since this Execute started.
    const state = await sessions.read(input.accountId);
    const snapshot = await sessions.snapshot(input.accountId);
    if (state.isFinished && snapshot.state?.status === "waiting_for_user_message" && snapshot.queuedMessageCount === 0) {
      await stopSession(client, sessionId, "review finished");
      return gracefulComplete("review finished");
    }
    if (snapshot.state?.status === "failed") {
      return goTo(PostWatchNote, { ...input, note: `The agent session failed (${(snapshot.state.lastTurnError ?? "no detail").slice(0, 200)}), so this review stops here.` });
    }
    if (state.thread !== undefined) {
      const after = threadCursor.get(context) ?? state.thread.ts;
      const fresh = (await this.readThread(context, state.thread))
        .filter((message) => isLater(message.timestamp, after) && message.userId !== undefined && message.userId !== state.thread?.botUserId)
        .filter((message) => this.settings.reviewerSlackIds.has(message.userId!))
        .map((message) => ({ ts: message.timestamp, userId: message.userId!, text: message.text.trim() }));
      if (fresh.length > 0) {
        relayedReplies.set(context, [...(relayedReplies.get(context) ?? []), ...fresh].slice(-maxRecordedReplies));
        threadCursor.set(context, fresh.at(-1)!.ts);
        return goTo(ForwardReplies, { accountId: input.accountId, fresh });
      }
    }
    if (round % this.accountCheckEveryRounds === 0 && !state.isApprovedHere && !state.isRejectedHere && reportedStatus.get(context) === undefined) {
      const account = await reviewApi.getAccount(input.accountId, AbortSignal.timeout(20_000));
      // A status the reviewers' own decision explains is this review's decision on its way, not one made elsewhere.
      const isOwnDecision = (state.decision === "approve" && account.status === "active") || (state.decision === "reject" && account.status === "rejected");
      if (account.status !== "pending_approval" && !isOwnDecision) {
        await sessions.sendOnce(input.accountId, `[dex-cloud ${account.status}]`, "The account was decided in Dex Cloud admin.");
        reportedStatus.set(context, account.status);
        return goTo(WatchThread, { accountId: input.accountId });
      }
    }
    return undefined;
  }

  /** The thread's messages, oldest first, at most 20 pages of 15, read with the Slack connector inside this Step. */
  private async readThread(context: AsyncContext, thread: { channel: string; ts: string }): Promise<SlackMessage[]> {
    const operation = this.settings.slack.operations.listThreadMessages();
    const call = createCall(context, this.settings.slack.reference, operation.definition().operation);
    const messages: SlackMessage[] = [];
    let pageCursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await runQuery(operation, call, { channelId: thread.channel, threadTimestamp: thread.ts, pageSize: 15, ...(pageCursor ? { cursor: pageCursor } : {}) });
      if (result.branch !== "read") {
        throw new Error(`reading the Slack thread ended ${result.branch}: ${result.failure?.message ?? ""}`);
      }
      messages.push(...(result.value.messages ?? []));
      pageCursor = result.value.nextCursor;
      if (!pageCursor) {
        break;
      }
    }
    return messages;
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
    return { attributes: [effects, relayedReplies, threadCursor, reportedStatus, ledgerRestarts] };
  }

  /**
   * Records one effect under its call key. `attempted` adds the effect once; `succeeded` completes it; `not_sent`
   * applies only to an attempted effect, with the caller's proof. A succeeded effect never changes.
   */
  public recordEffect(context: Context, effect: Omit<Effect, "at">): void {
    const recorded = effects.get(context) ?? [];
    const index = recorded.findIndex((candidate) => candidate.callKey === effect.callKey);
    const existing = index < 0 ? undefined : recorded[index]!;
    if (existing?.status === "succeeded" || (existing !== undefined && effect.status === "attempted")) {
      return;
    }
    if (existing === undefined && recorded.length >= maxEffects) {
      throw new Error(`the review ledger holds its maximum of ${maxEffects} effects`);
    }
    const next: Effect = { ...existing, ...effect, payload: effect.payload ?? existing?.payload, at: existing?.at ?? new Date().toISOString() };
    effects.set(context, existing === undefined ? [...recorded, next] : recorded.map((candidate, at) => (at === index ? next : candidate)));
  }
}

declareRPCMethod(SignupReviewLedgerFlow, "recordEffect", { name: "record_effect", lockAttributes: [effects.lock()] });
