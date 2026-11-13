// What the tools and the poller share: the review's FlowIDs, its thread and latest draft as the poller Flow holds them,
// and messages to the agent session.

import { setTimeout as sleep } from "node:timers/promises";

import { FlowNotActiveOrNotFoundError, FlowNotFoundError, IdReusePolicy, InitialAttribute, type Client } from "@superdurable/dex";
import {
  readAgentSnapshot,
  sendAgentUserMessage,
  type AgentFrameworkRunner,
  type AgentMessage,
  type AgentSessionFlow,
  type AgentSnapshot,
  type DeferredToolOutcome,
} from "@superdurable/dex-agents";

import { agentDecision, finishedAt, latestDraft, reviewThread, type Draft, type ReviewThread, type SignupReviewThreadPoller } from "./review-thread-poller.js";

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
  readonly isFinished: boolean;
  /** The decision approve_account or reject_account last made or tried. */
  readonly decision: string | undefined;
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
      const [thread, draft, finished, decision] = await this.dex.client.getAttributes(reviewPollerId(accountId), reviewThread, latestDraft, finishedAt, agentDecision);
      return { thread, latestDraft: draft, isFinished: finished !== undefined, decision };
    } catch (error: unknown) {
      if (isMissing(error)) {
        return { thread: undefined, latestDraft: undefined, isFinished: false, decision: undefined };
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

  /** Records the decision a decision tool is about to make, so the poller does not report it as made elsewhere. */
  public async recordDecision(accountId: string, decision: "approve" | "reject"): Promise<void> {
    await this.dex.client.invokeRPC(this.dex.pollerFlow.recordDecision, reviewPollerId(accountId), decision);
  }

  /** Marks the review finished; a poller that already ended has nothing left to stop. */
  public async finish(accountId: string): Promise<void> {
    await this.dex.client.invokeRPC(this.dex.pollerFlow.finish, reviewPollerId(accountId)).catch((error: unknown) => {
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

/** Whether Slack timestamp `ts` is later than `other`, compared exactly (`<seconds>.<microseconds>`). */
export function isLater(ts: string, other: string): boolean {
  const exact = (value: string): bigint => {
    const [seconds = "0", fraction = ""] = value.split(".");
    return BigInt(seconds) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
  };
  return exact(ts) > exact(other);
}
