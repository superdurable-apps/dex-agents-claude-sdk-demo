// SignupWatcher: a polling loop in the Worker process (not a Flow) that starts each pending sign-up's review.

import { setTimeout as sleep } from "node:timers/promises";

import { IdReusePolicy, type Client } from "@superdurable/dex";
import { startAgentSession } from "@superdurable/dex-agents";

import type { ReviewApiClient } from "./review-api.js";
import { reviewSessionId, type ReviewSessionFlow } from "./review-state.js";
import { firstReviewMessage } from "./signup-agent.js";
import { threadWatchFlowId, type SignupThreadWatchFlow } from "./thread-watch-flow.js";

export interface SignupWatcherParts {
  readonly client: Client;
  readonly sessionFlow: ReviewSessionFlow;
  readonly threadWatchFlow: SignupThreadWatchFlow;
  readonly reviewApi: ReviewApiClient;
}

/**
 * Starts, for every pending sign-up, its agent session and its thread-watch Flow. The FlowIDs and Request IDs come
 * from the account and used IDs are never reused, so starting again joins the same runs: one review per account.
 * @returns The accounts whose start failed, after logging each.
 */
export async function startPendingReviews(parts: SignupWatcherParts): Promise<string[]> {
  const failed: string[] = [];
  let pageToken = "";
  for (let page = 0; page < 10; page++) {
    const pending = await parts.reviewApi.listPendingAccounts(100, pageToken);
    for (const account of pending.accounts) {
      const start = { requestId: account.accountId, ignoreAlreadyStarted: true, idReusePolicy: IdReusePolicy.DISALLOW };
      try {
        await startAgentSession(parts.client, parts.sessionFlow, reviewSessionId(account.accountId), { initialMessage: firstReviewMessage(account) }, start);
        await parts.client.startFlow(parts.threadWatchFlow, threadWatchFlowId(account.accountId), { accountId: account.accountId }, start);
      } catch (error: unknown) {
        // One account's failure never holds up the others; the next round tries it again.
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
