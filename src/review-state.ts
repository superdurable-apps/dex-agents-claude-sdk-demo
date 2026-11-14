// What the tools and the poller share: the review's FlowIDs, its thread and latest draft as the poller Flow holds them,
// and messages to the agent session.

import { setTimeout as sleep } from "node:timers/promises";

import { FlowNotActiveOrNotFoundError, FlowNotFoundError, IdReusePolicy, InitialAttribute, StopType, type Client } from "@superdurable/dex";
import {
  readAgentSnapshot,
  sendAgentUserMessage,
  type AgentFrameworkRunner,
  type AgentMessage,
  type AgentSessionFlow,
  type AgentSnapshot,
  type DeferredToolOutcome,
} from "@superdurable/dex-agents";

import { latestDraft, reviewThread, type Draft, type ReviewThread, type SignupReviewThreadPoller } from "./review-thread-poller.js";

/** An agent session Flow of either harness. */
export type ReviewSessionFlow = AgentSessionFlow<AgentFrameworkRunner<DeferredToolOutcome>>;

export const reviewSessionId = (accountId: string): string => `signup-review-${accountId}`;
export const reviewPollerId = (accountId: string): string => `signup-review-${accountId}-poller`;
export const accountIdOf = (sessionId: string): string => sessionId.replace(/^signup-review-/, "");

/** Prefix of the tools' own refusals: nothing was sent. */
export const refusedPrefix = "refused: ";

export interface ReviewerReply {
  readonly ts: string;
  readonly userId: string;
  readonly text: string;
}

/** What the poller holds for the tools: absent until post_review started it. */
export interface ReviewRecord {
  readonly thread: ReviewThread | undefined;
  readonly latestDraft: Draft | undefined;
}

const isMissing = (error: unknown) => error instanceof FlowNotFoundError || error instanceof FlowNotActiveOrNotFoundError;

/** Reads and starts review pollers and sends sessions messages. Connect it once the Client and the Flows exist. */
export class ReviewSessions {
  private connected: { client: Client; sessionFlow: ReviewSessionFlow; pollerFlow: SignupReviewThreadPoller } | undefined;

  public constructor(public readonly reviewerIds: ReadonlySet<string>) {}

  public connect(client: Client, sessionFlow: ReviewSessionFlow, pollerFlow: SignupReviewThreadPoller): void {
    this.connected = { client, sessionFlow, pollerFlow };
  }

  private get dex() {
    if (this.connected === undefined) {
      throw new Error("ReviewSessions is not connected yet");
    }
    return this.connected;
  }

  /** The review's thread and latest draft from its poller; empty when no review post succeeded yet. */
  public async read(accountId: string): Promise<ReviewRecord> {
    try {
      const [thread, draft] = await this.dex.client.getAttributes(reviewPollerId(accountId), reviewThread, latestDraft);
      return { thread, latestDraft: draft };
    } catch (error: unknown) {
      if (isMissing(error)) {
        return { thread: undefined, latestDraft: undefined };
      }
      throw error;
    }
  }

  /**
   * Starts the review's poller with its thread and draft 1, after the review post went out. The Request ID comes from
   * the account, so a repeated start joins the same run; a passing Dex failure is tried again a few times, since a
   * posted review without a poller hears no reviewer.
   */
  public async startPoller(accountId: string, thread: ReviewThread, draft: Draft): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.dex.client.startFlow(this.dex.pollerFlow, reviewPollerId(accountId), { accountId }, {
          requestId: `${accountId}-poller`,
          ignoreAlreadyStarted: true,
          idReusePolicy: IdReusePolicy.DISALLOW,
          attributes: [InitialAttribute.of(reviewThread, thread), InitialAttribute.of(latestDraft, draft)],
        });
        return;
      } catch (error: unknown) {
        if (attempt >= 4) {
          throw error;
        }
        await sleep(250 * 2 ** attempt);
      }
    }
  }

  /** Records the draft post_draft posted as the latest one. */
  public async recordDraft(accountId: string, draft: Draft): Promise<void> {
    await this.dex.client.invokeRPC(this.dex.pollerFlow.recordDraft, reviewPollerId(accountId), draft);
  }

  /**
   * Ends the review: cancels its session, which never ends on its own; the poller sees that and completes. finish_review
   * calls it as its last act, so cancelling the session's own running tool Step loses nothing.
   */
  public async endSession(accountId: string, reason: string): Promise<void> {
    await this.dex.client.stopFlow(reviewSessionId(accountId), { type: StopType.CANCEL, reason }).catch((error: unknown) => {
      if (!isMissing(error)) {
        throw error;
      }
    });
  }

  public snapshot(accountId: string): Promise<AgentSnapshot> {
    return readAgentSnapshot(this.dex.client, this.dex.sessionFlow, reviewSessionId(accountId));
  }

  /** Sends `<marker> <text>` unless the session already holds or queues a message that starts with `marker`. */
  public async sendOnce(accountId: string, marker: string, text: string): Promise<void> {
    const { client, sessionFlow } = this.dex;
    const sessionId = reviewSessionId(accountId);
    const snapshot = await readAgentSnapshot(client, sessionFlow, sessionId);
    let messages: AgentMessage[] = [...snapshot.messages];
    for (let page = 0; page < 50 && (messages[0]?.sequence ?? 1) > 1; page++) {
      const older = await client.invokeRPC(sessionFlow.listAgentMessages, sessionId, { beforeSequence: messages[0]!.sequence, limit: 200 });
      if (older.messages.length === 0) {
        break;
      }
      messages = [...older.messages, ...messages];
    }
    const isThere =
      messages.some((message) => message.role === "user" && (message.text ?? "").startsWith(marker)) ||
      (snapshot.queuedMessages ?? []).some((pending) => pending.message.text.startsWith(marker));
    if (!isThere) {
      await sendAgentUserMessage(client, sessionFlow, sessionId, { text: `${marker} ${text}` });
    }
  }
}

/** The first retry of a failed turn waits this long; each later one twice as long, up to {@link maxRetryDelayMs}. */
export const firstRetryDelayMs = 2 * 60_000;
export const maxRetryDelayMs = 30 * 60_000;
/** Starts every retry message: `[retry turn-<n>]`, with the failed turn's ID. */
export const retryMarkerPrefix = "[retry ";

/** A failed turn of an idle session, and when and how to retry it. */
export interface FailedTurn {
  /** The failed turn, `turn-<n>`. */
  readonly turnId: string;
  /** Its error, short and on one line. */
  readonly error: string;
  /** Retries already sent since the message whose turn first failed: 0 for a fresh failure. */
  readonly retries: number;
  /** When the next retry is due, in epoch milliseconds. */
  readonly dueAt: number;
  /** The retry message's marker, unique per failed turn, and the text after it. */
  readonly marker: string;
  readonly text: string;
}

/**
 * The latest turn of an idle session if it failed, or `undefined`. A turn that ends well clears `lastTurnError`, and
 * a queued message starts a turn anyway, so neither counts. The back-off keeps no state of its own: the retries are
 * the retry messages after the message whose turn first failed, and the wait counts from the newest stored message.
 */
export function failedTurnOf(snapshot: AgentSnapshot, firstDelayMs = firstRetryDelayMs): FailedTurn | undefined {
  const state = snapshot.state;
  if (state?.status !== "waiting_for_user_message" || !state.lastTurnError || snapshot.queuedMessageCount > 0 || state.turnCount < 1) {
    return undefined;
  }
  const users = snapshot.messages.filter((message) => message.role === "user" && message.origin === undefined);
  const isRetry = (message: AgentMessage) => (message.text ?? "").startsWith(retryMarkerPrefix);
  const original = [...users].reverse().find((message) => !isRetry(message));
  const retries = users.filter((message) => isRetry(message) && message.sequence > (original?.sequence ?? 0)).length;
  const newest = snapshot.messages.at(-1);
  const since = newest === undefined ? Date.now() : Date.parse(newest.createdAt);
  const turnId = `turn-${state.turnCount}`;
  const error = state.lastTurnError.replace(/\s+/g, " ").trim().slice(0, 200);
  // The failed turn's message is quoted, since a harness may not have kept a turn that failed.
  const quoted = (original?.text ?? "").slice(0, 4_000);
  return {
    turnId,
    error,
    retries,
    dueAt: since + Math.min(firstDelayMs * 2 ** retries, maxRetryDelayMs),
    marker: `${retryMarkerPrefix}${turnId}]`,
    text: `The previous turn failed (${error}). Handle this message again as new, then continue the review from where you left off:\n${quoted}`,
  };
}

/** Whether Slack timestamp `ts` is later than `other`, compared exactly (`<seconds>.<microseconds>`). */
export function isLater(ts: string, other: string): boolean {
  const exact = (value: string): bigint => {
    const [seconds = "0", fraction = ""] = value.split(".");
    return BigInt(seconds) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
  };
  return exact(ts) > exact(other);
}
