// SignupThreadWatchFlow: one small Dex Flow per review that relays reviewer replies from Slack to the agent session.
// It exists only until the TypeScript Slack connector has a thread-reply Trigger (dex-connectors-library#720): Slack
// calls belong in a Dex Step, so the thread is polled here, in one long-running Execute, as the Dex polling pattern does.

import { setTimeout as sleep } from "node:timers/promises";

import { createCall, runQuery, throwDexRetry } from "@superdurable/connectors-sdk";
import type { Connection as SlackConnection } from "@superdurable/connector-slack";
import {
  Attribute,
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

import type { ReviewApiClient } from "./review-api.js";
import { isLater, reviewSessionId, type ReviewSessions } from "./review-state.js";

export const threadWatchFlowId = (accountId: string): string => `signup-review-${accountId}-thread`;

/** The last Slack timestamp relayed to the session. */
export const threadCursor = new Attribute("Cursor", stringCodec);
/** The account status already reported to the session as `[dex-cloud <status>]`. */
const reportedStatus = new Attribute("ReportedStatus", stringCodec);

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

// dex:group group-id:relay group-label:"Relay"
// dex:explanation text:"Polls the review thread, relays new reviewer replies to the agent session, and ends with the review."
class WatchThread implements Step<{ accountId: string }> {
  private readonly pollIntervalMs: number;
  private readonly accountCheckEveryRounds: number;
  private readonly maxReviewAgeMs: number;

  public constructor(private readonly settings: ThreadWatchSettings) {
    this.pollIntervalMs = settings.pollIntervalMs ?? 15_000;
    this.accountCheckEveryRounds = settings.accountCheckEveryRounds ?? 4;
    this.maxReviewAgeMs = settings.maxReviewAgeMs ?? 7 * 24 * 60 * 60_000;
  }

  public getStepType(): string {
    return "WatchThread";
  }

  public getStepOptions(): StepOptions {
    const maxWaitMs = this.maxReviewAgeMs + 60 * 60_000;
    return { executeMethodTimeoutMs: maxWaitMs, heartbeatTimeoutMs: 60_000, executeRetry: { maximumAttempts: 10, totalDurationMs: maxWaitMs } };
  }

  /** Returns after each relay, so the cursor commits; rounds without news stay inside this Execute. */
  public async execute(context: AsyncContext, input: { accountId: string }): Promise<StepDecision> {
    const { sessions, slack, reviewApi } = this.settings;
    const sessionId = reviewSessionId(input.accountId);
    for (let round = 1; ; round++) {
      const state = await sessions.read(sessionId).catch((error: unknown) => {
        if (error instanceof FlowNotActiveOrNotFoundError) {
          return undefined;
        }
        throw error;
      });
      if (state === undefined) {
        return gracefulComplete("the session ended");
      }
      const isIdle = state.snapshot.state?.status === "waiting_for_user_message" && state.snapshot.queuedMessageCount === 0;
      const isTooOld = Date.now() - context.flowStartedAt.getTime() > this.maxReviewAgeMs;
      if ((state.isFinished && isIdle) || state.snapshot.state?.status === "failed" || isTooOld) {
        const reason = state.isFinished ? "review finished" : isTooOld ? "no decision within 7 days" : "the session failed";
        await this.settings
          .client()
          .stopFlow(sessionId, { type: StopType.CANCEL, reason })
          .catch((error: unknown) => {
            if (!(error instanceof FlowNotActiveOrNotFoundError)) {
              throw error;
            }
          });
        return gracefulComplete(reason);
      }
      if (state.thread !== undefined) {
        const after = threadCursor.get(context) ?? state.thread.ts;
        const replies = (await this.readThread(context, state.thread)).filter(
          (message) =>
            isLater(message.timestamp, after) &&
            message.userId !== undefined &&
            message.userId !== state.thread?.botUserId &&
            this.settings.reviewerSlackIds.has(message.userId),
        );
        if (replies.length > 0) {
          for (const reply of replies) {
            await sessions.sendOnce(sessionId, `[slack ${reply.timestamp}]`, `<@${reply.userId}>: ${reply.text}`);
          }
          threadCursor.set(context, replies.at(-1)!.timestamp);
          return goTo(WatchThread, input);
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
      await context.recordHeartbeat(round);
      await sleep(this.pollIntervalMs, undefined, { signal: context.cancellationSignal });
    }
  }

  /** The thread's messages, oldest first, read with the Slack connector inside this Step. */
  private async readThread(context: AsyncContext, thread: { channel: string; ts: string }) {
    const operation = this.settings.slack.operations.listThreadMessages();
    const call = createCall(context, this.settings.slack.reference, operation.definition().operation);
    const messages = [];
    let pageCursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const input = { channelId: thread.channel, threadTimestamp: thread.ts, pageSize: 15, ...(pageCursor ? { cursor: pageCursor } : {}) };
      const result = await runQuery(operation, call, input).catch(throwDexRetry);
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

export class SignupThreadWatchFlow implements Flow<{ accountId: string }> {
  private readonly watchThread: WatchThread;

  public constructor(settings: ThreadWatchSettings) {
    this.watchThread = new WatchThread(settings);
  }

  public getFlowType(): string {
    return "SignupThreadWatchFlow";
  }

  public getSteps(): StepList<{ accountId: string }> {
    return StepList.startStep(this.watchThread);
  }

  public getPersistenceSchema(): PersistenceSchema {
    return { attributes: [threadCursor, reportedStatus] };
  }
}
