// SignupWatcher: a polling loop in the Worker process (not a Flow) that starts each pending sign-up's review.

import { setTimeout as sleep } from "node:timers/promises";

import { FlowNotActiveOrNotFoundError, FlowNotFoundError, IdReusePolicy, type Client, type FlowInfo } from "@superdurable/dex";
import { startAgentSession } from "@superdurable/dex-agents";

import type { Account, ReviewApiClient } from "./review-api.js";
import { relayedReplies, reviewSessionId, threadCursor, threadWatchFlowId, type ReviewSessionFlow } from "./review-state.js";
import { firstReviewMessage } from "./signup-agent.js";
import type { SignupThreadWatchFlow } from "./thread-watch-flow.js";

export interface SignupWatcherParts {
  readonly client: Client;
  readonly sessionFlow: ReviewSessionFlow;
  readonly threadWatchFlow: SignupThreadWatchFlow;
  readonly reviewApi: ReviewApiClient;
  /** Only sign-ups registered at or after this time are reviewed: the backlog before the demo is left alone. */
  readonly reviewSince: Date;
}

async function describeOrUndefined(client: Client, flowId: string): Promise<FlowInfo | undefined> {
  try {
    return await client.describeFlow(flowId);
  } catch (error: unknown) {
    if (error instanceof FlowNotFoundError || error instanceof FlowNotActiveOrNotFoundError) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Starts one review: the session (FlowID and Request ID from the account, used IDs never reused, so starting again
 * joins the same run) and, while the session runs, its thread-watch Flow. A watch that ended while the session still
 * runs is started again under a Request ID named after the ended run, carrying its replies and cursor.
 */
async function startReview(parts: SignupWatcherParts, account: Account): Promise<void> {
  const { client } = parts;
  const { accountId } = account;
  const sessionId = reviewSessionId(accountId);
  await startAgentSession(client, parts.sessionFlow, sessionId, { initialMessage: firstReviewMessage(account) }, {
    requestId: accountId,
    ignoreAlreadyStarted: true,
    idReusePolicy: IdReusePolicy.DISALLOW,
  });
  const watchId = threadWatchFlowId(accountId);
  const watch = await describeOrUndefined(client, watchId);
  if (watch?.status === "running" || (await client.describeFlow(sessionId)).status !== "running") {
    return;
  }
  const [replies, cursor] = watch === undefined ? [undefined, undefined] : await client.getAttributes(watchId, relayedReplies, threadCursor);
  await client.startFlow(
    parts.threadWatchFlow,
    watchId,
    { accountId, ...(replies === undefined ? {} : { replies }), ...(cursor === undefined ? {} : { cursor }) },
    { requestId: watch === undefined ? `${accountId}-thread` : `${accountId}-thread-after-${watch.runId}`, ignoreAlreadyStarted: true, idReusePolicy: IdReusePolicy.ALLOW_IF_NOT_RUNNING },
  );
}

/**
 * Starts the review of every pending sign-up registered since `reviewSince`.
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
