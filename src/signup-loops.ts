// The only glue outside the agent: two polling loops in the Worker process, not Flows.
// SignupWatcher starts one review session per pending sign-up; SlackReplyRelay forwards reviewer replies to it.
// The relay goes away once the TypeScript Slack connector has a thread-reply Trigger.

import { setTimeout as sleep } from "node:timers/promises";

import { FlowAlreadyStartedError, IdReusePolicy, StopType } from "@superdurable/dex";
import { sendAgentUserMessage, startAgentSession } from "@superdurable/dex-agents";

import { accountIdOf, dex, hasUserMessage, readReviewerReplies, readReviewState, reviewSessionId } from "./review-state.js";
import type { SignupServices } from "./signup-agent.js";

const maxReviewAgeMs = 7 * 24 * 60 * 60_000;

/** Runs `round` every `intervalMs` until `signal` aborts; a failed round is logged and the loop goes on. */
async function every(intervalMs: number, signal: AbortSignal, name: string, round: () => Promise<unknown>): Promise<void> {
  while (!signal.aborted) {
    await round().catch((error: unknown) => console.warn(`${name}: ${error instanceof Error ? error.message : String(error)}`));
    await sleep(intervalMs, undefined, { signal }).catch(() => undefined);
  }
}

/** Starts the review session of every pending sign-up; starting one that exists is a no-op. */
export async function startPendingReviews(services: SignupServices, started = new Set<string>()): Promise<string[]> {
  const { client, flow } = dex as Required<typeof dex>;
  const startedNow: string[] = [];
  let pageToken = "";
  for (let page = 0; page < 10; page++) {
    const pending = await services.reviewApi.listPendingAccounts(100, pageToken);
    for (const { accountId } of pending.accounts.filter((account) => !started.has(account.accountId))) {
      try {
        // FlowID and Request ID come from the account, and used IDs are never reused: one review per account.
        await startAgentSession(
          client,
          flow,
          reviewSessionId(accountId),
          { initialMessage: `Review Dex Cloud account ${accountId}` },
          { requestId: accountId, ignoreAlreadyStarted: true, idReusePolicy: IdReusePolicy.DISALLOW },
        );
        startedNow.push(accountId);
      } catch (error: unknown) {
        if (!(error instanceof FlowAlreadyStartedError)) {
          throw error;
        }
      }
      started.add(accountId);
      if (started.size > 10_000) {
        started.delete(started.values().next().value!);
      }
    }
    pageToken = pending.nextPageToken;
    if (pageToken === "") {
      break;
    }
  }
  return startedNow;
}

/**
 * One relay round over the running review sessions: forward each new reviewer reply as `[slack <ts>] <text>`,
 * tell a session when its account was decided in Dex Cloud admin, and stop sessions that finished. Each message is
 * sent only when the session does not already hold its marker, so a repeated round never sends it twice.
 */
export async function relaySlackReplies(services: SignupServices, round: number, signal: AbortSignal): Promise<void> {
  const { client, flow } = dex as Required<typeof dex>;
  const query = `FlowType = "${flow.getFlowType()}" AND ExecutionStatus = "Running"`;
  let pageToken = "";
  for (let page = 0; page < 5; page++) {
    const result = await client.searchFlows(query, 100, pageToken);
    for (const session of result.flows) {
      const state = await readReviewState(session.flowId);
      const isIdle = state.snapshot.state?.status === "waiting_for_user_message" && state.snapshot.queuedMessageCount === 0;
      if ((state.isFinished && isIdle) || Date.now() - session.startedAt.getTime() > maxReviewAgeMs) {
        await client.stopFlow(session.flowId, { type: StopType.CANCEL, reason: state.isFinished ? "review finished" : "no decision within 7 days" });
        continue;
      }
      if (state.thread === undefined) {
        continue;
      }
      const send = async (marker: string, text: string) => {
        if (!hasUserMessage(state.snapshot, marker)) {
          await sendAgentUserMessage(client, flow, session.flowId, { text: `${marker} ${text}` });
        }
      };
      for (const reply of await readReviewerReplies(services.slack, session.flowId, state.thread, services.reviewerSlackIds, signal)) {
        await send(`[slack ${reply.timestamp}]`, `<@${reply.userId}>: ${reply.text}`);
      }
      if (round % 4 === 0 && !state.isApprovedHere && !state.isRejectedHere) {
        const account = await services.reviewApi.getAccount(accountIdOf(session.flowId), signal);
        if (account.status !== "pending_approval") {
          await send(`[dex-cloud ${account.status}]`, "The account was decided in Dex Cloud admin.");
        }
      }
    }
    pageToken = result.nextPageToken;
    if (pageToken === "") {
      break;
    }
  }
}

/** Runs both loops until `signal` aborts. */
export async function runSignupLoops(services: SignupServices, intervals: { watchMs: number; relayMs: number }, signal: AbortSignal): Promise<void> {
  const started = new Set<string>();
  let round = 0;
  await Promise.all([
    every(intervals.watchMs, signal, "signup watcher", () => startPendingReviews(services, started)),
    every(intervals.relayMs, signal, "slack reply relay", () => relaySlackReplies(services, ++round, signal)),
  ]);
}
