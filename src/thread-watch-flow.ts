// SignupThreadWatchFlow: one small Dex Flow per review that relays reviewer replies from Slack to the agent session.
// It exists only until the TypeScript Slack connector has a thread-reply Trigger (dex-connectors-library#720): Slack
// calls belong in a Dex Step, so the thread is polled here, in one long-running Execute, as the Dex polling pattern does.

import { setTimeout as sleep } from "node:timers/promises";

import { createCall, RetryError, runMutation, runQuery, throwDexRetry } from "@superdurable/connectors-sdk";
import type { Connection as SlackConnection, Message as SlackMessage } from "@superdurable/connector-slack";
import {
  Attribute,
  DexServiceError,
  ExecuteFailure,
  FlowNotActiveOrNotFoundError,
  StepList,
  StopType,
  gracefulComplete,
  goTo,
  stringCodec,
  type AsyncContext,
  type Client,
  type Flow,
  type PersistenceSchema,
  type Step,
  type StepDecision,
  type StepOptions,
} from "@superdurable/dex";

import { ReviewApiError, type ReviewApiClient } from "./review-api.js";
import { isLater, relayedReplies, reviewSessionId, threadCursor, type ReviewSessions, type ReviewerReply } from "./review-state.js";

/** Start input; a restarted watch carries the replies and cursor of the run it replaces. */
export interface ThreadWatchInput {
  readonly accountId: string;
  readonly replies?: readonly ReviewerReply[];
  readonly cursor?: string;
}

/** The account status already reported to the session as `[dex-cloud <status>]`. */
const reportedStatus = new Attribute("ReportedStatus", stringCodec);
const maxRecordedReplies = 500;

export interface ThreadWatchSettings {
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

/** Failures that skip one round instead of failing the Step: Slack and ReviewAPI back-pressure, Dex hiccups, network. */
function isTransient(error: unknown): boolean {
  if (error instanceof RetryError) {
    return true;
  }
  if (error instanceof ReviewApiError) {
    return error.httpStatus === 429 || error.httpStatus >= 500;
  }
  if (error instanceof DexServiceError) {
    return [4, 8, 10, 14].includes(Number(error.code)); // DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED, ABORTED, UNAVAILABLE
  }
  return error instanceof TypeError && /fetch failed/i.test(error.message);
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

async function stopSession(client: Client, sessionId: string, reason: string): Promise<void> {
  await client.stopFlow(sessionId, { type: StopType.CANCEL, reason }).catch((error: unknown) => {
    if (!(error instanceof FlowNotActiveOrNotFoundError)) {
      throw error;
    }
  });
}

// dex:group group-id:relay group-label:"Relay"
// dex:explanation text:"Polls the review thread, records new reviewer replies, and ends with the review."
class WatchThread implements Step<ThreadWatchInput> {
  private readonly pollIntervalMs: number;
  private readonly accountCheckEveryRounds: number;
  private readonly maxReviewAgeMs: number;

  public constructor(private readonly settings: ThreadWatchSettings) {
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
    return {
      executeMethodTimeoutMs: maxWaitMs,
      heartbeatTimeoutMs: 60_000,
      // Transient failures stay inside the loop; these attempts are for crashes, then the failure route.
      executeRetry: { maximumAttempts: 4, totalDurationMs: maxWaitMs },
      executeFailure: ExecuteFailure.proceedTo(PostWatchNote),
    };
  }

  /** Returns after each new batch of replies, so they and the cursor commit before ForwardReplies sends them. */
  public async execute(context: AsyncContext, input: ThreadWatchInput): Promise<StepDecision> {
    let delayMs = this.pollIntervalMs;
    for (let round = 1; ; round++) {
      try {
        const decision = await this.round(context, input, round);
        if (decision !== undefined) {
          return decision;
        }
        delayMs = this.pollIntervalMs;
      } catch (error: unknown) {
        if (!isTransient(error)) {
          throw error;
        }
        console.warn(`thread watch ${context.flowId}: skipped a round: ${describe(error)}`);
        delayMs = Math.min(delayMs * 2, 40_000);
      }
      // Sleep in slices with a heartbeat each, so a long back-off never misses the heartbeat timeout.
      for (let slept = 0; slept < delayMs; slept += 15_000) {
        await context.recordHeartbeat(round);
        await sleep(Math.min(15_000, delayMs - slept), undefined, { signal: context.cancellationSignal });
      }
    }
  }

  private async round(context: AsyncContext, input: ThreadWatchInput, round: number): Promise<StepDecision | undefined> {
    const { sessions, reviewApi } = this.settings;
    const sessionId = reviewSessionId(input.accountId);
    const client = this.settings.client();
    if ((await client.describeFlow(sessionId)).status !== "running") {
      return gracefulComplete("the session ended");
    }
    const state = await sessions.read(sessionId);
    const isIdle = state.snapshot.state?.status === "waiting_for_user_message" && state.snapshot.queuedMessageCount === 0;
    if (state.isFinished && isIdle) {
      await stopSession(client, sessionId, "review finished");
      return gracefulComplete("review finished");
    }
    if (state.snapshot.state?.status === "failed") {
      return goTo(PostWatchNote, { ...input, note: `The agent session failed (${(state.snapshot.state.lastTurnError ?? "no detail").slice(0, 200)}), so this review stops here.` });
    }
    if (Date.now() - context.flowStartedAt.getTime() > this.maxReviewAgeMs) {
      return goTo(PostWatchNote, { ...input, note: "No decision arrived within 7 days, so this review stops here." });
    }
    if (state.thread !== undefined) {
      const recorded = relayedReplies.get(context) ?? [...(input.replies ?? [])];
      const after = threadCursor.get(context) ?? input.cursor ?? state.thread.ts;
      const fresh = (await this.readThread(context, state.thread))
        .filter((message) => isLater(message.timestamp, after) && message.userId !== undefined && message.userId !== state.thread?.botUserId)
        .filter((message) => this.settings.reviewerSlackIds.has(message.userId!))
        .map((message) => ({ ts: message.timestamp, userId: message.userId!, text: message.text.trim() }));
      if (fresh.length > 0) {
        relayedReplies.set(context, [...recorded, ...fresh].slice(-maxRecordedReplies));
        threadCursor.set(context, fresh.at(-1)!.ts);
        return goTo(ForwardReplies, { ...input, fresh });
      }
    }
    if (round % this.accountCheckEveryRounds === 0 && !state.isApprovedHere && !state.isRejectedHere && reportedStatus.get(context) === undefined) {
      const account = await reviewApi.getAccount(input.accountId, AbortSignal.timeout(20_000));
      // A status the reviewers' own decision explains is this review's decision on its way, not one made elsewhere.
      const isOwnDecision = (state.decision === "approve" && account.status === "active") || (state.decision === "reject" && account.status === "rejected");
      if (account.status !== "pending_approval" && !isOwnDecision) {
        await sessions.sendOnce(sessionId, `[dex-cloud ${account.status}]`, "The account was decided in Dex Cloud admin.");
        reportedStatus.set(context, account.status);
        return goTo(WatchThread, input);
      }
    }
    return undefined;
  }

  /** The thread's messages, oldest first, read with the Slack connector inside this Step. */
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
class ForwardReplies implements Step<ThreadWatchInput & { fresh: ReviewerReply[] }> {
  public constructor(private readonly settings: ThreadWatchSettings) {}

  public getStepType(): string {
    return "ForwardReplies";
  }

  public getStepOptions(): StepOptions {
    return { executeRetry: { maximumAttempts: 10, totalDurationMs: 60 * 60_000 }, executeFailure: ExecuteFailure.proceedTo(PostWatchNote) };
  }

  public async execute(_context: AsyncContext, input: ThreadWatchInput & { fresh: ReviewerReply[] }): Promise<StepDecision> {
    for (const reply of input.fresh) {
      await this.settings.sessions.sendOnce(reviewSessionId(input.accountId), `[slack ${reply.ts}]`, `<@${reply.userId}>: ${reply.text}`);
    }
    return goTo(WatchThread, { accountId: input.accountId });
  }
}

// dex:group group-id:relay group-label:"Relay"
// dex:explanation text:"Posts why the review stopped in its thread, stops the agent session, and completes."
class PostWatchNote implements Step<ThreadWatchInput & { note?: string }> {
  public constructor(private readonly settings: ThreadWatchSettings) {}

  public getStepType(): string {
    return "PostWatchNote";
  }

  public getStepOptions(): StepOptions {
    return { executeDurability: "sync", executeRetry: { maximumAttempts: 5, totalDurationMs: 10 * 60_000 } };
  }

  public async execute(context: AsyncContext, input: ThreadWatchInput & { note?: string }): Promise<StepDecision> {
    const sessionId = reviewSessionId(input.accountId);
    const note = input.note ?? `The relay of this review failed (${(context.recoveryError?.detail ?? "unknown").slice(0, 200)}), so this review stops here.`;
    const thread = await this.settings.sessions.read(sessionId).then((state) => state.thread).catch(() => undefined);
    if (thread !== undefined) {
      const operation = this.settings.slack.operations.postThreadReply();
      const call = createCall(context, this.settings.slack.reference, operation.definition().operation);
      // One post under the connector's call identity; an uncertain outcome is not repeated for a note.
      await runMutation(operation, call, { channelId: thread.channel, threadTimestamp: thread.ts, text: `${note} Decide on the account in Dex Cloud admin.` }).catch(throwDexRetry);
    }
    await stopSession(this.settings.client(), sessionId, note);
    return gracefulComplete(note);
  }
}

export class SignupThreadWatchFlow implements Flow<ThreadWatchInput> {
  private readonly watchThread: WatchThread;
  private readonly forwardReplies: ForwardReplies;
  private readonly postWatchNote: PostWatchNote;

  public constructor(settings: ThreadWatchSettings) {
    this.watchThread = new WatchThread(settings);
    this.forwardReplies = new ForwardReplies(settings);
    this.postWatchNote = new PostWatchNote(settings);
  }

  public getFlowType(): string {
    return "SignupThreadWatchFlow";
  }

  public getSteps(): StepList<ThreadWatchInput> {
    return StepList.startStep(this.watchThread).otherSteps(this.forwardReplies, this.postWatchNote);
  }

  public getPersistenceSchema(): PersistenceSchema {
    return { attributes: [relayedReplies, threadCursor, reportedStatus] };
  }
}
