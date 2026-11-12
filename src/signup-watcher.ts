// SignupWatcher: a process-local polling task (not a Flow) that starts one SignupReviewFlow per pending sign-up.

import { setTimeout as sleep } from "node:timers/promises";

import { FlowAlreadyStartedError, IdReusePolicy, type Client } from "@superdurable/dex";

import type { ReviewApiClient } from "./review-api/review-api-client.js";
import { signupReviewFlowId, type SignupReviewFlow } from "./signup-review/signup-review-flow.js";
import type { AgentHarness } from "./signup-review/signup-review-values.js";

/** Settings of {@link SignupWatcher}. */
export interface SignupWatcherOptions {
  readonly intervalMs: number;
  /** The harness that reviews the sign-ups this watcher starts. */
  readonly harness: AgentHarness;
  /** Pages of 100 per round; later sign-ups wait for the next round. */
  readonly maxPagesPerRound?: number;
  /** Account IDs remembered as started in this process. */
  readonly maxRememberedAccounts?: number;
  readonly log?: (line: string) => void;
}

/**
 * Every interval, lists pending sign-ups and starts a review for each one it has not started in this process.
 * The start uses the FlowID `signup-review-<accountId>`, the Request ID `<accountId>` and a reuse policy that rejects
 * every used ID, so a restarted watcher never starts a second review: one account gets one review, ever.
 */
export class SignupWatcher {
  private readonly started = new Set<string>();
  private readonly maxPagesPerRound: number;
  private readonly maxRememberedAccounts: number;
  private readonly log: (line: string) => void;

  public constructor(
    private readonly client: Client,
    private readonly flow: SignupReviewFlow,
    private readonly reviewApi: ReviewApiClient,
    private readonly options: SignupWatcherOptions,
  ) {
    this.maxPagesPerRound = options.maxPagesPerRound ?? 10;
    this.maxRememberedAccounts = options.maxRememberedAccounts ?? 10_000;
    this.log = options.log ?? ((line) => console.log(line));
  }

  /** Runs rounds until `signal` aborts. A failed round is logged and retried at the next interval. */
  public async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.runRound(signal);
      } catch (error: unknown) {
        if (signal.aborted) {
          return;
        }
        this.log(`signup watcher: the round failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        await sleep(this.options.intervalMs, undefined, { signal });
      } catch {
        return;
      }
    }
  }

  /** One round: page through pending sign-ups and start the reviews not started yet. Returns the started IDs. */
  public async runRound(signal?: AbortSignal): Promise<string[]> {
    const startedNow: string[] = [];
    let pageToken = "";
    for (let page = 0; page < this.maxPagesPerRound; page++) {
      const result = await this.reviewApi.listPendingAccounts(100, pageToken, signal);
      for (const account of result.accounts) {
        if (this.started.has(account.accountId)) {
          continue;
        }
        if (await this.startReview(account.accountId)) {
          startedNow.push(account.accountId);
        }
        this.remember(account.accountId);
      }
      pageToken = result.nextPageToken;
      if (pageToken === "") {
        break;
      }
    }
    return startedNow;
  }

  private async startReview(accountId: string): Promise<boolean> {
    const flowId = signupReviewFlowId(accountId);
    try {
      await this.client.startFlow(
        this.flow,
        flowId,
        { accountId, harness: this.options.harness },
        { requestId: accountId, ignoreAlreadyStarted: true, idReusePolicy: IdReusePolicy.DISALLOW },
      );
      this.log(`signup watcher: review ${flowId} is running (${this.options.harness})`);
      return true;
    } catch (error: unknown) {
      if (error instanceof FlowAlreadyStartedError) {
        // Reviewed before, under another request: the account keeps that one review.
        return false;
      }
      throw error;
    }
  }

  private remember(accountId: string): void {
    if (this.started.size >= this.maxRememberedAccounts) {
      const oldest = this.started.values().next().value;
      if (oldest !== undefined) {
        this.started.delete(oldest);
      }
    }
    this.started.add(accountId);
  }
}
