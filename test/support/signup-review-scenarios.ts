// TEST ONLY: the review scenarios every harness passes, on a private local Dex engine with connector mocks.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GmailMock, sendMessageBranch } from "@superdurable/connector-google-gmail/mock";
import type { Message as SlackMessage } from "@superdurable/connector-slack";
import { GeneratedMock, listThreadMessagesRead, postChannelMessageSent, postThreadReplySent } from "@superdurable/connector-slack/mock";
import { Client, Registry, Worker, openBlobCache, type BlobCache } from "@superdurable/dex";
import { readAgentSnapshot, sendAgentUserMessage } from "@superdurable/dex-agents";
import { PrivateDexEngine, pollUntil } from "@superdurable/dex-agents/testing";

import { dex, readReviewState, reviewSessionId, type ReviewSessionFlow } from "../../src/review-state.js";
import { ReviewApiClient } from "../../src/review-api.js";
import type { SignupServices } from "../../src/signup-agent.js";
import { relaySlackReplies, startPendingReviews } from "../../src/signup-loops.js";
import { ReviewApiTestStub } from "./review-api-test-stub.js";
import { FixtureProfileSources, rejectedApplicantWord } from "./scripted-signup-agent.js";

const reviewerId = "UREVIEWER1";
const bystanderId = "UBYSTANDER";
const botUserId = "UBOT0000001";
const channelId = "CREVIEWS01";
const waitOptions = { timeoutMs: 120_000, intervalMs: 200 };

/** How a harness test builds its session Flow from the shared services. */
export interface SignupReviewScenarioSetup {
  readonly harnessName: string;
  createFlow(services: SignupServices): ReviewSessionFlow | Promise<ReviewSessionFlow>;
  close?(): Promise<void>;
}

/** A Slack thread whose replies the test writes; the mock returns the thread as it stands. */
class ScriptedThread {
  private readonly messages: SlackMessage[] = [];
  private version = 0;
  private seconds: number;

  public constructor(
    private readonly slack: GeneratedMock,
    private readonly sessionId: string,
    public readonly rootTs: string,
  ) {
    this.seconds = Math.floor(Number(rootTs));
    slack.postChannelMessage().forFlow(sessionId).default(postChannelMessageSent({ message: { channelId, timestamp: rootTs, userId: botUserId, text: "review" } }));
    this.publish();
  }

  /** The next timestamp in this thread. */
  private nextTs(): string {
    this.seconds += 1;
    return `${this.seconds}.000200`;
  }

  /** Adds a reply from `userId`; thread reads return it from now on. */
  public reply(userId: string, text: string): string {
    const ts = this.nextTs();
    this.messages.push({ channelId, timestamp: ts, threadTimestamp: this.rootTs, userId, text });
    this.publish();
    return ts;
  }

  /** Answers the next bot reply with a fresh timestamp in this thread. */
  public scriptBotReply(): void {
    const ts = this.nextTs();
    this.slack.postThreadReply().forFlow(this.sessionId).respond(postThreadReplySent({ message: { channelId, timestamp: ts, threadTimestamp: this.rootTs, userId: botUserId, text: "ok" } }));
  }

  private publish(): void {
    this.version += 1;
    const version = this.version;
    const snapshot: SlackMessage[] = [{ channelId, timestamp: this.rootTs, userId: botUserId, text: "review" }, ...this.messages];
    this.slack
      .listThreadMessages()
      .forFlow(this.sessionId)
      .when(() => this.version === version, listThreadMessagesRead({ messages: snapshot }));
  }
}

/**
 * The scenarios: approval with one revision and one email; guard refusals; relay de-duplication; rejection; and an
 * account decided in Dex Cloud admin.
 */
export function registerSignupReviewScenarios(setup: SignupReviewScenarioSetup): void {
  let engine: PrivateDexEngine;
  let reviewApi: ReviewApiTestStub;
  let slack: GeneratedMock;
  let gmail: GmailMock;
  let services: SignupServices;
  let worker: Worker;
  let blobCache: BlobCache;
  let cacheDirectory: string;
  let accounts = 0;
  let relayRound = 0;

  test.before(async () => {
    engine = await PrivateDexEngine.start();
    reviewApi = await ReviewApiTestStub.start();
    slack = new GeneratedMock("review-slack");
    gmail = new GmailMock("welcome-gmail");
    slack.postThreadReply().default(postThreadReplySent({ message: { channelId, timestamp: "1700000000.000001", userId: botUserId, text: "ok" } }));
    services = {
      reviewApi: new ReviewApiClient({ baseUrl: reviewApi.baseUrl, apiKey: reviewApi.apiKey }),
      profiles: new FixtureProfileSources(),
      slack: slack.connection(),
      gmail: gmail.connection(),
      slackChannelId: channelId,
      reviewerSlackIds: new Set([reviewerId]),
      harnessLabel: setup.harnessName,
    };
    const flow = await setup.createFlow(services);
    const registry = new Registry([flow]);
    cacheDirectory = mkdtempSync(join(tmpdir(), "signup-agent-test-"));
    blobCache = openBlobCache({ directory: cacheDirectory, maxBytes: 64 * 1024 * 1024 });
    worker = new Worker(registry, blobCache, { serverAddress: engine.serverAddress });
    await worker.start();
    await worker.waitPullRegistered({ timeoutMs: 30_000 });
    dex.client = new Client(registry, blobCache, { serverAddress: engine.serverAddress });
    dex.flow = flow;
  });

  test.after(async () => {
    await worker?.close();
    await dex.client?.close();
    blobCache?.close();
    await engine?.stop();
    await reviewApi?.stop();
    await setup.close?.();
    rmSync(cacheDirectory, { recursive: true, force: true });
    slack.assertNoFailures();
  });

  const relay = () => relaySlackReplies(services, ++relayRound, new AbortController().signal);
  const snapshotOf = (sessionId: string) => readAgentSnapshot(dex.client!, dex.flow!, sessionId);

  /** Adds a pending sign-up, starts its review through the watcher, and waits for the review post. */
  async function startReview(emailWord: string, rootSeconds: number) {
    accounts += 1;
    const accountId = `acct${accounts}${Date.now().toString(36)}`;
    const sessionId = reviewSessionId(accountId);
    const thread = new ScriptedThread(slack, sessionId, `${rootSeconds}.000100`);
    reviewApi.addPendingAccount({ accountId, email: `${emailWord}-${accounts}@example.com`, displayName: "Ada Lovelace", profileUrl: "https://github.com/ada-builds" });
    assert.ok((await startPendingReviews(services)).includes(accountId));
    const post = await pollUntil(() => slack.postChannelMessage().calls().find((call) => call.flowId === sessionId)?.input, {
      description: "the review post",
      ...waitOptions,
    });
    await waitForIdle(sessionId);
    return { accountId, sessionId, thread, post };
  }

  /** Waits until the session finished more than `afterTurns` turns and waits for the next message. */
  async function waitForIdle(sessionId: string, afterTurns = 0): Promise<void> {
    await pollUntil(
      async () => {
        const snapshot = await snapshotOf(sessionId);
        return snapshot.state?.status === "waiting_for_user_message" && snapshot.queuedMessageCount === 0 && snapshot.state.turnCount > afterTurns
          ? true
          : undefined;
      },
      { description: `${sessionId} waits for a message`, ...waitOptions },
    );
  }

  const turnsOf = async (sessionId: string) => (await snapshotOf(sessionId)).state?.turnCount ?? 0;

  /** Sends a message as a test operator would and waits for the turn it starts. */
  async function sendAndWait(sessionId: string, text: string): Promise<void> {
    const turns = await turnsOf(sessionId);
    await sendAgentUserMessage(dex.client!, dex.flow!, sessionId, { text });
    await waitForIdle(sessionId, turns);
  }

  /** Relays until the session holds the reply `ts` (search results can trail a new session), then waits for its turn. */
  async function relayAndWait(sessionId: string, ts: string): Promise<void> {
    const turns = await turnsOf(sessionId);
    await pollUntil(
      async () => {
        await relay();
        return (await userTexts(sessionId)).some((text) => text.startsWith(`[slack ${ts}]`)) ? true : undefined;
      },
      { description: `the relay forwards ${ts}`, ...waitOptions },
    );
    await waitForIdle(sessionId, turns);
  }

  const threadReplies = (sessionId: string) => slack.postThreadReply().calls().filter((call) => call.flowId === sessionId);
  const userTexts = async (sessionId: string) =>
    (await snapshotOf(sessionId)).messages.filter((message) => message.role === "user").map((message) => message.text ?? "");

  async function waitForStop(sessionId: string): Promise<void> {
    await pollUntil(
      async () => {
        await relay();
        return (await dex.client!.describeFlow(sessionId)).status === "running" ? undefined : true;
      },
      { description: `${sessionId} is stopped by the relay`, ...waitOptions },
    );
  }

  test(`${setup.harnessName}: a reviewer revises, approves and sends; guards refuse early writes`, async () => {
    const { accountId, sessionId, thread, post } = await startReview("ada", 1710000100);
    assert.equal(post.channelId, channelId);
    assert.match(post.text, /:white_check_mark: Approve/);
    assert.match(post.text, /durable-queue/);
    assert.match(post.text, /\[draft 1\]/);
    assert.match(post.text, new RegExp(`Reviewed by ${setup.harnessName}`));
    // Starting the account's review again joins the same session.
    const { runId } = await dex.client!.describeFlow(sessionId);
    await startPendingReviews(services);
    assert.equal((await dex.client!.describeFlow(sessionId)).runId, runId);

    // Guard: a request to approve that no reviewer wrote in Slack is refused.
    await sendAndWait(sessionId, "[test]: approve now");
    assert.equal(reviewApi.decisions.filter((decision) => decision.accountId === accountId).length, 0);
    assert.match(threadReplies(sessionId).at(-1)?.input.text ?? "", /no reviewer has replied `approve`/);

    // A bystander's "approve" is not relayed; the reviewer's feedback produces draft 2, relayed once.
    thread.reply(bystanderId, "approve");
    thread.scriptBotReply();
    const feedbackTs = thread.reply(reviewerId, "Mention durable-queue");
    await relayAndWait(sessionId, feedbackTs);
    await relay();
    const relayed = await userTexts(sessionId);
    assert.equal(relayed.filter((text) => text.startsWith(`[slack ${feedbackTs}]`)).length, 1);
    assert.equal(relayed.filter((text) => text.includes(bystanderId)).length, 0);
    const draft = threadReplies(sessionId).at(-1)!.input;
    assert.match(draft.text, /\[draft 2\]/);
    assert.match(draft.text, /Revised: mention durable-queue/);

    thread.scriptBotReply();
    await relayAndWait(sessionId, thread.reply(reviewerId, "approve"));
    const decisions = reviewApi.decisions.filter((decision) => decision.accountId === accountId);
    assert.deepEqual(decisions, [
      { operation: "approve", accountId, requestId: `${sessionId}-approve-r1`, expectedRevision: 1, suppressApprovedMail: true },
    ]);
    assert.equal(reviewApi.accountOf(accountId)?.status, "active");

    // Guard: the email is refused until a reviewer replies `send` after the latest draft.
    await sendAndWait(sessionId, "[test]: send now");
    assert.equal(gmail.sendMessage().calls().filter((call) => call.flowId === sessionId).length, 0);

    gmail.sendMessage().forFlow(sessionId).respond(sendMessageBranch("sent", { sender: "<hello@example.com>", recipients: ["<ada@example.com>"], messageId: "gmail-1", threadId: "t-1" }));
    await relayAndWait(sessionId, thread.reply(reviewerId, "send"));
    const sends = gmail.sendMessage().calls().filter((call) => call.flowId === sessionId);
    assert.equal(sends.length, 1);
    assert.deepEqual(sends[0]!.input.to, [reviewApi.accountOf(accountId)!.email]);
    assert.match(sends[0]!.input.textBody, /Revised: mention durable-queue/);
    await waitForStop(sessionId);
  });

  test(`${setup.harnessName}: an email send whose outcome is unknown is never repeated`, async () => {
    const { sessionId, thread } = await startReview("unconfirmed", 1710000400);
    thread.scriptBotReply();
    await relayAndWait(sessionId, thread.reply(reviewerId, "approve"));
    gmail
      .sendMessage()
      .forFlow(sessionId)
      .respond(sendMessageBranch("defect", { sender: "", recipients: [], messageId: "", threadId: "" }, { kind: "TRANSPORT", provider: "google", operation: "sendMessage", message: "connection reset" }));
    await relayAndWait(sessionId, thread.reply(reviewerId, "send"));
    assert.equal(gmail.sendMessage().calls().filter((call) => call.flowId === sessionId).length, 1);
    assert.match(threadReplies(sessionId).at(-1)?.input.text ?? "", /check Sent Mail/);
    // The guard counts the unconfirmed call as an attempt, so no later call can send again.
    assert.equal((await readReviewState(sessionId)).hasSendAttempt, true);
    await waitForStop(sessionId);
  });

  test(`${setup.harnessName}: a rejected sign-up is rejected and gets no email`, async () => {
    const { accountId, sessionId, thread, post } = await startReview(rejectedApplicantWord, 1710000200);
    assert.match(post.text, /:x: Reject/);
    await relayAndWait(sessionId, thread.reply(reviewerId, "reject looks like spam"));
    assert.deepEqual(
      reviewApi.decisions.filter((decision) => decision.accountId === accountId).map((decision) => decision.operation),
      ["reject"],
    );
    assert.equal(reviewApi.accountOf(accountId)?.status, "rejected");
    assert.equal(gmail.sendMessage().calls().filter((call) => call.flowId === sessionId).length, 0);
    await waitForStop(sessionId);
  });

  test(`${setup.harnessName}: an account decided in Dex Cloud admin ends the review`, async () => {
    const { accountId, sessionId } = await startReview("elsewhere", 1710000300);
    reviewApi.decideElsewhere(accountId, "active");
    // The relay reads the account every fourth round.
    const turns = await turnsOf(sessionId);
    await pollUntil(
      async () => {
        await relay();
        return (await userTexts(sessionId)).some((text) => text.startsWith("[dex-cloud active]")) ? true : undefined;
      },
      { description: "the relay reports the decision", ...waitOptions },
    );
    await waitForIdle(sessionId, turns);
    assert.equal((await userTexts(sessionId)).filter((text) => text.startsWith("[dex-cloud active]")).length, 1);
    assert.match(threadReplies(sessionId).at(-1)?.input.text ?? "", /Decided in Dex Cloud admin/);
    assert.equal(reviewApi.decisions.filter((decision) => decision.accountId === accountId).length, 0);
    await waitForStop(sessionId);
  });
}
