// SignupWatcher: a polling loop in the Worker process (not a Flow) that starts each pending sign-up's review session.
// It only starts sessions; the reviewers' replies reach them through the Slack reply Trigger.

import { setTimeout as sleep } from "node:timers/promises";

import { IdReusePolicy, type Client } from "@superdurable/dex";
import { startAgentSession } from "@superdurable/dex-agents";

import type { Account, ReviewApiClient } from "./review-api.js";
import { reviewSessionId, type ReviewSessionFlow } from "./review-state.js";
import { firstReviewMessage } from "./signup-agent.js";

export interface SignupWatcherParts {
  readonly client: Client;
  readonly sessionFlow: ReviewSessionFlow;
  readonly reviewApi: ReviewApiClient;
  /** Only sign-ups registered at or after this time are reviewed: the backlog before the demo is left alone. */
  readonly reviewSince: Date;
}

/** Starts one pending review's session. Its FlowID and Request ID come from the account, and the ID is never reused. */
async function startReview(parts: SignupWatcherParts, account: Account): Promise<void> {
  const { accountId } = account;
  await startAgentSession(parts.client, parts.sessionFlow, reviewSessionId(accountId), { initialMessage: firstReviewMessage(account) }, {
    requestId: accountId,
    ignoreAlreadyStarted: true,
    idReusePolicy: IdReusePolicy.DISALLOW,
  });
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
