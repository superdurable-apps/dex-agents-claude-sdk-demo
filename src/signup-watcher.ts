// SignupWatcher: a polling loop in the Worker process (not a Flow) that starts each pending sign-up's review.

import { setTimeout as sleep } from "node:timers/promises";

import { FlowNotActiveOrNotFoundError, FlowNotFoundError, IdReusePolicy, InitialAttribute, StopType, stringCodec, type Client, type FlowInfo } from "@superdurable/dex";
import { startAgentSession } from "@superdurable/dex-agents";

import type { Account, ReviewApiClient } from "./review-api.js";
import { accountIdOf, effects, ledgerRestarts, relayedReplies, reviewLedgerId, reviewSessionId, threadCursor, threadPage, type ReviewSessionFlow } from "./review-state.js";
import { noSessionStarted, type SignupReviewLedgerFlow } from "./review-ledger-flow.js";
import { firstReviewMessage } from "./signup-agent.js";

/** A ledger that keeps ending (such as a Slack app without access) is not started again after this many runs. */
const maxLedgerRestarts = 3;

export interface SignupWatcherParts {
  readonly client: Client;
  readonly sessionFlow: ReviewSessionFlow;
  readonly ledgerFlow: SignupReviewLedgerFlow;
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
 * Keeps a review's ledger alive while its session runs. A ledger that ended is started again, at most
 * `maxLedgerRestarts` times, under a Request ID named after the ended run, with that run's effects, replies and
 * cursors as its initial Attributes. When the cap is reached, or the ledger ended before its session existed, the
 * session is cancelled, so no review runs without a ledger.
 */
async function reviveLedger(parts: SignupWatcherParts, accountId: string, ledger: FlowInfo): Promise<void> {
  const { client } = parts;
  const ledgerId = reviewLedgerId(accountId);
  const [recorded, replies, cursor, page, restarts] = await client.getAttributes(ledgerId, effects, relayedReplies, threadCursor, threadPage, ledgerRestarts);
  const result = ledger.status === "completed" ? await client.waitForFlow(ledgerId, 5_000) : undefined;
  const endedBeforeSession = (() => {
    try {
      return result?.singleOutput(stringCodec) === noSessionStarted;
    } catch {
      return false;
    }
  })();
  if (endedBeforeSession || (restarts ?? 0) >= maxLedgerRestarts) {
    console.warn(`signup watcher: the ledger of ${accountId} cannot run again; its session is cancelled`);
    await client.stopFlow(reviewSessionId(accountId), { type: StopType.CANCEL, reason: "the review ledger ended" });
    return;
  }
  await client.startFlow(parts.ledgerFlow, ledgerId, { accountId, isRestart: true }, {
    requestId: `${accountId}-ledger-after-${ledger.runId}`,
    ignoreAlreadyStarted: true,
    idReusePolicy: IdReusePolicy.ALLOW_IF_NOT_RUNNING,
    attributes: [
      InitialAttribute.of(effects, recorded ?? []),
      InitialAttribute.of(relayedReplies, replies ?? []),
      InitialAttribute.of(ledgerRestarts, (restarts ?? 0) + 1),
      ...(cursor === undefined ? [] : [InitialAttribute.of(threadCursor, cursor)]),
      ...(page === undefined ? [] : [InitialAttribute.of(threadPage, page)]),
    ],
  });
}

/**
 * Starts one pending review: its ledger first, since no write tool dispatches without one, then its session. FlowIDs
 * and Request IDs come from the account, and the session's ID is never reused, so starting again joins the same runs.
 */
async function startReview(parts: SignupWatcherParts, account: Account): Promise<void> {
  const { client } = parts;
  const { accountId } = account;
  const ledgerId = reviewLedgerId(accountId);
  const [ledger, session] = await Promise.all([describeOrUndefined(client, ledgerId), describeOrUndefined(client, reviewSessionId(accountId))]);
  if (ledger === undefined) {
    await client.startFlow(parts.ledgerFlow, ledgerId, { accountId }, { requestId: `${accountId}-ledger`, ignoreAlreadyStarted: true, idReusePolicy: IdReusePolicy.ALLOW_IF_NOT_RUNNING });
  } else if (ledger.status !== "running" && session?.status === "running") {
    await reviveLedger(parts, accountId, ledger);
  }
  if (session === undefined) {
    await startAgentSession(client, parts.sessionFlow, reviewSessionId(accountId), { initialMessage: firstReviewMessage(account) }, {
      requestId: accountId,
      ignoreAlreadyStarted: true,
      idReusePolicy: IdReusePolicy.DISALLOW,
    });
  }
}

/** Revives the ledgers of running sessions, such as reviews whose account is no longer pending; at most 500 per round. */
async function reviveRunningReviews(parts: SignupWatcherParts): Promise<void> {
  let pageToken = "";
  for (let page = 0; page < 5; page++) {
    const sessions = await parts.client.searchFlows(`FlowType = "${parts.sessionFlow.getFlowType()}" AND ExecutionStatus = "Running"`, 100, pageToken);
    for (const session of sessions.flows) {
      const accountId = accountIdOf(session.flowId);
      const ledger = await describeOrUndefined(parts.client, reviewLedgerId(accountId));
      if (ledger !== undefined && ledger.status !== "running") {
        await reviveLedger(parts, accountId, ledger).catch((error: unknown) => console.warn(`signup watcher: ${accountId}: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
    pageToken = sessions.nextPageToken;
    if (pageToken === "") {
      break;
    }
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
  await reviveRunningReviews(parts).catch((error: unknown) => console.warn(`signup watcher: ${error instanceof Error ? error.message : String(error)}`));
  return failed;
}

/** Runs {@link startPendingReviews} every `intervalMs` until `signal` aborts. */
export async function runSignupWatcher(parts: SignupWatcherParts, intervalMs: number, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    await startPendingReviews(parts).catch((error: unknown) => console.warn(`signup watcher: ${error instanceof Error ? error.message : String(error)}`));
    await sleep(intervalMs, undefined, { signal }).catch(() => undefined);
  }
}
