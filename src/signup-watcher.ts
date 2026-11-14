// SignupWatcher: a polling loop in the Worker process (not a Flow) that starts each pending sign-up's review session,
// and retries a failed turn of one that has no thread poller yet. The session's post_review starts the poller.

import { setTimeout as sleep } from "node:timers/promises";

import { FlowNotActiveOrNotFoundError, FlowNotFoundError, IdReusePolicy, type Client } from "@superdurable/dex";
import { startAgentSession } from "@superdurable/dex-agents";

import type { Account, ReviewApiClient } from "./review-api.js";
import { failedTurnOf, reviewPollerId, reviewSessionId, type ReviewSessionFlow, type ReviewSessions } from "./review-state.js";
import { firstReviewMessage } from "./signup-agent.js";

export interface SignupWatcherParts {
  readonly client: Client;
  readonly sessionFlow: ReviewSessionFlow;
  readonly sessions: ReviewSessions;
  readonly reviewApi: ReviewApiClient;
  /** Only sign-ups registered at or after this time are reviewed: the backlog before the demo is left alone. */
  readonly reviewSince: Date;
  /** The wait before the first retry of a failed turn; 2 minutes by default. */
  readonly firstRetryDelayMs?: number;
}

/**
 * Starts one pending review's session. Its FlowID and Request ID come from the account, and the ID is never reused.
 * A session whose latest turn failed before its review post, so that no poller watches it yet, is retried here.
 */
async function startReview(parts: SignupWatcherParts, account: Account): Promise<void> {
  const { accountId } = account;
  await startAgentSession(parts.client, parts.sessionFlow, reviewSessionId(accountId), { initialMessage: firstReviewMessage(account) }, {
    requestId: accountId,
    ignoreAlreadyStarted: true,
    idReusePolicy: IdReusePolicy.DISALLOW,
  });
  const failed = failedTurnOf(await parts.sessions.snapshot(accountId), parts.firstRetryDelayMs);
  if (failed === undefined || (await isRunning(parts.client, reviewPollerId(accountId)))) {
    return;
  }
  // Checked again right before the send: a poller that started meanwhile owns the retry.
  if (Date.now() >= failed.dueAt && !(await isRunning(parts.client, reviewPollerId(accountId)))) {
    // No thread to post in yet, and connector calls run only in a Dex Step: the log is the only notice.
    if (await parts.sessions.retryFailedTurn(accountId, failed.turnId, parts.firstRetryDelayMs)) {
      console.warn(`signup watcher: ${accountId}: the agent's ${failed.turnId} failed (${failed.error}); retry ${failed.retries + 1} sent`);
    }
  }
}

async function isRunning(client: Client, flowId: string): Promise<boolean> {
  try {
    return (await client.describeFlow(flowId)).status === "running";
  } catch (error: unknown) {
    if (error instanceof FlowNotFoundError || error instanceof FlowNotActiveOrNotFoundError) {
      return false;
    }
    throw error;
  }
}

/**
 * Starts the review of every pending sign-up registered since `reviewSince`. The ReviewAPI lists the oldest first,
 * and one round reads at most 10 pages of 100, so at most 1,000 pending sign-ups are looked at per round.
 * @returns The accounts whose start failed, after logging each; the next round tries them again.
 */
export async function startPendingReviews(parts: SignupWatcherParts): Promise<string[]> {
  const failed: string[] = [];
  let pageToken = "";
  for (let page = 0; page < 10; page++) {
    const pending = await parts.reviewApi.listPendingAccounts(100, pageToken);
    for (const account of pending.accounts.filter((candidate) => Date.parse(candidate.registeredAt) >= parts.reviewSince.getTime())) {
      try {
        await startReview(parts, account);
      } catch (error: unknown) {
        // One account's failure never holds up the others.
        console.warn(`signup watcher: ${account.accountId}: ${error instanceof Error ? error.message : String(error)}`);
        failed.push(account.accountId);
      }
    }
    pageToken = pending.nextPageToken;
    if (pageToken === "") {
      break;
    }
  }
  return failed;
}

/** Runs {@link startPendingReviews} every `intervalMs` until `signal` aborts. */
export async function runSignupWatcher(parts: SignupWatcherParts, intervalMs: number, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    await startPendingReviews(parts).catch((error: unknown) => console.warn(`signup watcher: ${error instanceof Error ? error.message : String(error)}`));
    await sleep(intervalMs, undefined, { signal }).catch(() => undefined);
  }
}
