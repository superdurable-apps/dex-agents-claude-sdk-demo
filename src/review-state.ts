// The facts of a review, from its ledger: the per-account Dex Flow that records every external effect and every relayed
// reviewer reply. Guards decide only from the ledger and the ReviewAPI, never from the session's message history, which
// the model's output and tool results can shape.

import { setTimeout as sleep } from "node:timers/promises";

import { Attribute, FlowNotActiveOrNotFoundError, FlowNotFoundError, RpcLockConflictError, doubleCodec, jsonCodec, stringCodec, type Client } from "@superdurable/dex";
import {
  readAgentSnapshot,
  sendAgentUserMessage,
  type AgentFrameworkRunner,
  type AgentMessage,
  type AgentSessionFlow,
  type AgentSnapshot,
  type DeferredToolOutcome,
} from "@superdurable/dex-agents";

import type { SignupReviewLedgerFlow } from "./review-ledger-flow.js";

/** An agent session Flow of either harness. */
export type ReviewSessionFlow = AgentSessionFlow<AgentFrameworkRunner<DeferredToolOutcome>>;

export const reviewSessionId = (accountId: string): string => `signup-review-${accountId}`;
export const reviewLedgerId = (accountId: string): string => `signup-review-${accountId}-ledger`;
export const accountIdOf = (sessionId: string): string => sessionId.replace(/^signup-review-/, "");

/** Prefixes of the tools' own failures that prove nothing was sent. */
export const refusedPrefix = "refused: ";
export const notSentPrefix = "not sent: ";

export interface ReviewerReply {
  readonly ts: string;
  readonly userId: string;
  readonly text: string;
}

/**
 * One external effect of the review. A write tool records `attempted` before it dispatches and `succeeded` or
 * `not_sent` (only with proof that nothing went out) after; an `attempted` effect without either may have happened.
 */
export interface Effect {
  /** The Dex per-call identity: the same on every attempt of one tool call. */
  readonly callKey: string;
  readonly tool: string;
  readonly status: "attempted" | "succeeded" | "not_sent";
  /** What it did, kept small: the Slack message's channel, timestamp and user, the draft, the decision. */
  readonly result?: Record<string, unknown> | undefined;
  readonly at: string;
}

/** Ledger state: every reviewer reply it relayed, oldest first, recorded before it is forwarded. */
export const relayedReplies = new Attribute<ReviewerReply[]>("RelayedReplies", jsonCodec({ typeName: "ReviewerReplies" }));
/** Ledger state: the timestamp of the last relayed reply. */
export const threadCursor = new Attribute("Cursor", stringCodec);
/** Ledger state: every effect, in the order of their first record. */
export const effects = new Attribute<Effect[]>("Effects", jsonCodec({ typeName: "Effects" }));
/** Ledger state: the Slack page cursor of the newest thread page read; each round reads that one page. */
export const threadPage = new Attribute("ThreadPage", stringCodec);
/** Ledger state: how many ledger runs came before this one for the same review. */
export const ledgerRestarts = new Attribute("Restarts", doubleCodec);

export interface Draft {
  readonly number: number;
  readonly subject: string;
  readonly body: string;
  readonly ts: string;
}

/** The facts of one review, as the ledger has them. */
export interface ReviewState {
  readonly effects: readonly Effect[];
  /** The review's Slack thread, once a review post succeeded, and the bot user that posted it. */
  readonly thread?: { readonly channel: string; readonly ts: string; readonly botUserId: string | undefined };
  /** The newest draft whose post succeeded. */
  readonly latestDraft?: Draft;
  /** Drafts whose post may have gone out, the review post included. */
  readonly draftAttempts: number;
  /** Whether a draft post newer than the latest draft may have gone out without a confirmation. */
  readonly hasUnconfirmedNewerDraft: boolean;
  /** When a review post that may have gone out without a confirmation was attempted. */
  readonly unconfirmedReviewPostAt?: string;
  readonly replies: readonly ReviewerReply[];
  /** The latest reply that decides: exactly `approve`, `reject <reason>`, or `hold`, which cancels both. */
  readonly decision?: "approve" | "reject";
  readonly isApprovedHere: boolean;
  readonly isRejectedHere: boolean;
  /** Whether a send may have gone out. */
  readonly hasSendAttempt: boolean;
  readonly isFinished: boolean;
}

/** The facts from the ledger's effects and replies. */
export function factsOf(recorded: readonly Effect[], allReplies: readonly ReviewerReply[], reviewerIds: ReadonlySet<string>): ReviewState {
  const mayHaveHappened = (effect: Effect) => effect.status === "attempted" || effect.status === "succeeded";
  const reviewPost = recorded.find((effect) => effect.tool === "post_review" && effect.status === "succeeded");
  const reviewMessage = reviewPost?.result?.message as { channelId?: string; timestamp?: string; userId?: string } | undefined;
  let latestDraft: Draft | undefined;
  let hasUnconfirmedNewerDraft = false;
  for (const effect of recorded.filter((candidate) => candidate.tool === "post_review" || candidate.tool === "post_draft")) {
    if (effect.status === "succeeded") {
      const draft = effect.result?.draft as Omit<Draft, "ts"> | null | undefined;
      const ts = String((effect.result?.message as { timestamp?: string } | undefined)?.timestamp ?? "");
      latestDraft = draft ? { ...draft, ts } : effect.tool === "post_review" ? undefined : latestDraft;
      hasUnconfirmedNewerDraft = false;
    } else if (effect.status === "attempted" && effect.tool === "post_draft") {
      hasUnconfirmedNewerDraft = true;
    }
  }
  const replies = allReplies.filter((reply) => reviewerIds.has(reply.userId) && reply.userId !== reviewMessage?.userId);
  let decision: "approve" | "reject" | undefined;
  for (const reply of replies) {
    decision = /^approve$/i.test(reply.text) ? "approve" : /^reject\s+\S/i.test(reply.text) ? "reject" : /^hold$/i.test(reply.text) ? undefined : decision;
  }
  const unconfirmedReviewPost = reviewPost === undefined ? recorded.find((effect) => effect.tool === "post_review" && effect.status === "attempted") : undefined;
  const decided = (tool: string, status: string) => recorded.some((effect) => effect.tool === tool && effect.status === "succeeded" && effect.result?.status === status);
  return {
    effects: recorded,
    ...(reviewMessage?.timestamp ? { thread: { channel: String(reviewMessage.channelId), ts: reviewMessage.timestamp, botUserId: reviewMessage.userId } } : {}),
    ...(latestDraft === undefined ? {} : { latestDraft }),
    // The review post is draft 1 however many calls it took; each post_draft that may have gone out is the next.
    draftAttempts:
      (recorded.some((effect) => effect.tool === "post_review" && mayHaveHappened(effect)) ? 1 : 0) +
      recorded.filter((effect) => effect.tool === "post_draft" && mayHaveHappened(effect)).length,
    hasUnconfirmedNewerDraft,
    ...(unconfirmedReviewPost === undefined ? {} : { unconfirmedReviewPostAt: unconfirmedReviewPost.at }),
    replies,
    ...(decision === undefined ? {} : { decision }),
    isApprovedHere: decided("approve_account", "approved"),
    isRejectedHere: decided("reject_account", "rejected"),
    hasSendAttempt: recorded.some((effect) => effect.tool === "send_welcome_email" && mayHaveHappened(effect)),
    isFinished: recorded.some((effect) => effect.tool === "finish_review" && effect.status === "succeeded"),
  };
}

/** A ledger that does not exist: the guards refuse, since nothing could be recorded. */
export class MissingLedgerError extends Error {}

/** Reads review ledgers, records effects, and sends sessions messages. Connect it once the Client and the Flows exist. */
export class ReviewSessions {
  private connected: { client: Client; sessionFlow: ReviewSessionFlow; ledgerFlow: SignupReviewLedgerFlow } | undefined;

  public constructor(public readonly reviewerIds: ReadonlySet<string>) {}

  public connect(client: Client, sessionFlow: ReviewSessionFlow, ledgerFlow: SignupReviewLedgerFlow): void {
    this.connected = { client, sessionFlow, ledgerFlow };
  }

  private get dex() {
    if (this.connected === undefined) {
      throw new Error("ReviewSessions is not connected yet");
    }
    return this.connected;
  }

  /** The review's facts from its ledger. */
  public async read(accountId: string): Promise<ReviewState> {
    try {
      const [recorded, replies] = await this.dex.client.getAttributes(reviewLedgerId(accountId), effects, relayedReplies);
      return factsOf(recorded ?? [], replies ?? [], this.reviewerIds);
    } catch (error: unknown) {
      if (error instanceof FlowNotFoundError || error instanceof FlowNotActiveOrNotFoundError) {
        throw new MissingLedgerError(`the review ledger ${reviewLedgerId(accountId)} does not exist`);
      }
      throw error;
    }
  }

  /** Records an effect in the review's ledger; a failure means nothing may be dispatched. */
  public async record(accountId: string, effect: Omit<Effect, "at">): Promise<void> {
    await retryOnLockConflict(() => this.dex.client.invokeRPC(this.dex.ledgerFlow.recordEffect, reviewLedgerId(accountId), effect));
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

/** Runs `work`, retrying up to 4 times with a growing pause when another RPC holds the ledger's lock. */
export async function retryOnLockConflict<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error: unknown) {
      if (!(error instanceof RpcLockConflictError) || attempt >= 4) {
        throw error;
      }
      await sleep(100 * 2 ** attempt);
    }
  }
}

/** Whether Slack timestamp `ts` is later than `other`, compared exactly (`<seconds>.<microseconds>`). */
export function isLater(ts: string, other: string): boolean {
  const exact = (value: string): bigint => {
    const [seconds = "0", fraction = ""] = value.split(".");
    return BigInt(seconds) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
  };
  return exact(ts) > exact(other);
}
