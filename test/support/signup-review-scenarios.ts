// TEST ONLY: the review scenarios every harness passes, on a private local Dex engine with connector mocks.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GmailMock, sendMessageBranch } from "@superdurable/connector-google-gmail/mock";
import type { Message as SlackMessage } from "@superdurable/connector-slack";
import { GeneratedMock, listThreadMessagesRead, postChannelMessageSent, postThreadReplySent, postThreadReplyUncertain } from "@superdurable/connector-slack/mock";
import { Client, Registry, Worker, openBlobCache, type BlobCache } from "@superdurable/dex";
import { readAgentSnapshot, sendAgentUserMessage } from "@superdurable/dex-agents";
import { PrivateDexEngine, pollUntil } from "@superdurable/dex-agents/testing";

import { ReviewApiClient } from "../../src/review-api.js";
import { ReviewSessions, reviewSessionId, type ReviewSessionFlow } from "../../src/review-state.js";
import type { SignupServices } from "../../src/signup-agent.js";
import { startPendingReviews } from "../../src/signup-watcher.js";
import { SignupThreadWatchFlow, threadCursor, threadWatchFlowId } from "../../src/thread-watch-flow.js";
import { ReviewApiTestStub } from "./review-api-test-stub.js";
import { FixtureProfileSources, injectingLogin, passiveApplicantWord, rejectedApplicantWord } from "./scripted-signup-agent.js";

const reviewerId = "UREVIEWER1";
const bystanderId = "UBYSTANDER";
const botUserId = "UBOT0000001";
const channelId = "CREVIEWS01";
const waitOptions = { timeoutMs: 120_000, intervalMs: 200 };
const failure = (operation: string, message: string) => ({ kind: "TRANSPORT" as const, provider: "slack", operation, message });

/** How a harness test builds its session Flow from the shared services. */
export interface SignupReviewScenarioSetup {
  readonly harnessName: string;
  createFlow(services: SignupServices): ReviewSessionFlow | Promise<ReviewSessionFlow>;
  close?(): Promise<void>;
}

/** A Slack thread whose replies the test writes; the thread-watch Flow's reads return it as it stands. */
class ScriptedThread {
  private readonly messages: SlackMessage[] = [];
  private version = 0;
  private seconds: number;

  public constructor(
    private readonly slack: GeneratedMock,
    private readonly sessionId: string,
    private readonly watchId: string,
    public readonly rootTs: string,
  ) {
    this.seconds = Math.floor(Number(rootTs));
    slack.postChannelMessage().forFlow(sessionId).default(postChannelMessageSent({ message: { channelId, timestamp: rootTs, userId: botUserId, text: "review" } }));
    slack.postThreadReply().forFlow(sessionId).default(postThreadReplySent({ message: { channelId, timestamp: `${this.seconds}.000900`, threadTimestamp: rootTs, userId: botUserId, text: "ok" } }));
    this.publish();
  }

  private nextTs(): string {
    this.seconds += 1;
    return `${this.seconds}.000200`;
  }

  /** Adds a message from `userId`; thread reads return it from now on. */
  public reply(userId: string, text: string): string {
    const ts = this.nextTs();
    this.messages.push({ channelId, timestamp: ts, threadTimestamp: this.rootTs, userId, text });
    this.publish();
    return ts;
  }

  /** Answers the session's next thread reply with a fresh timestamp, or as an uncertain post. */
  public scriptBotReply(isUncertain = false): void {
    const message = { channelId, timestamp: this.nextTs(), threadTimestamp: this.rootTs, userId: botUserId, text: "ok" };
    this.slack
      .postThreadReply()
      .forFlow(this.sessionId)
      .respond(isUncertain ? postThreadReplyUncertain({ message: { ...message, timestamp: "" } }, failure("postThreadReply", "lost")) : postThreadReplySent({ message }));
  }

  private publish(): void {
    this.version += 1;
    const version = this.version;
    const snapshot: SlackMessage[] = [{ channelId, timestamp: this.rootTs, userId: botUserId, text: "review" }, ...this.messages];
    this.slack
      .listThreadMessages()
      .forFlow(this.watchId)
      .when(() => this.version === version, listThreadMessagesRead({ messages: snapshot }));
  }
}

/** Registers the scenarios every harness passes. */
export function registerSignupReviewScenarios(setup: SignupReviewScenarioSetup): void {
  let engine: PrivateDexEngine;
  let reviewApi: ReviewApiTestStub;
  let slack: GeneratedMock;
  let gmail: GmailMock;
  let services: SignupServices;
  let client: Client;
  let registry: Registry;
  let worker: Worker;
  let blobCache: BlobCache;
  let cacheDirectory: string;
  let sessionFlow: ReviewSessionFlow;
  let threadWatchFlow: SignupThreadWatchFlow;
  let accounts = 0;

  test.before(async () => {
    engine = await PrivateDexEngine.start();
    reviewApi = await ReviewApiTestStub.start();
    slack = new GeneratedMock("review-slack");
    gmail = new GmailMock("welcome-gmail");
    services = {
      sessions: new ReviewSessions(new Set([reviewerId, botUserId])),
      reviewApi: new ReviewApiClient({ baseUrl: reviewApi.baseUrl, apiKey: reviewApi.apiKey }),
      profiles: new FixtureProfileSources(),
      slack: slack.connection(),
      gmail: gmail.connection(),
      slackChannelId: channelId,
      harnessLabel: setup.harnessName,
    };
    sessionFlow = await setup.createFlow(services);
    // The bot is listed as a reviewer on purpose: its own posts must still never count.
    threadWatchFlow = new SignupThreadWatchFlow({ ...services, reviewerSlackIds: new Set([reviewerId, botUserId]), client: () => client, pollIntervalMs: 200, accountCheckEveryRounds: 3 });
    registry = new Registry([sessionFlow, threadWatchFlow]);
    cacheDirectory = mkdtempSync(join(tmpdir(), "signup-agent-test-"));
    blobCache = openBlobCache({ directory: cacheDirectory, maxBytes: 64 * 1024 * 1024 });
    client = new Client(registry, blobCache, { serverAddress: engine.serverAddress });
    services.sessions.connect(client, sessionFlow);
    worker = await startWorker();
  });

  async function startWorker(): Promise<Worker> {
    const started = new Worker(registry, blobCache, { serverAddress: engine.serverAddress, pull: { stopDrainTimeoutMs: 1_000 } });
    await started.start();
    await started.waitPullRegistered({ timeoutMs: 30_000 });
    return started;
  }

  test.after(async () => {
    await worker?.close();
    await client?.close();
    blobCache?.close();
    await engine?.stop();
    await reviewApi?.stop();
    await setup.close?.();
    rmSync(cacheDirectory, { recursive: true, force: true });
    slack.assertNoFailures();
  });

  const snapshotOf = (sessionId: string) => readAgentSnapshot(client, sessionFlow, sessionId);
  const turnsOf = async (sessionId: string) => (await snapshotOf(sessionId)).state?.turnCount ?? 0;
  const userTexts = async (sessionId: string) => (await snapshotOf(sessionId)).messages.filter((message) => message.role === "user").map((message) => message.text ?? "");
  const threadReplies = (sessionId: string) => slack.postThreadReply().calls().filter((call) => call.flowId === sessionId);
  const lastReply = (sessionId: string) => threadReplies(sessionId).at(-1)?.input.text ?? "";
  const decisionsOf = (accountId: string) => reviewApi.decisions.filter((decision) => decision.accountId === accountId);

  /** Waits until the session finished more than `afterTurns` turns and waits for the next message. */
  async function waitForIdle(sessionId: string, afterTurns = 0): Promise<void> {
    await pollUntil(
      async () => {
        const snapshot = await snapshotOf(sessionId);
        return snapshot.state?.status === "waiting_for_user_message" && snapshot.queuedMessageCount === 0 && snapshot.state.turnCount > afterTurns ? true : undefined;
      },
      { description: `${sessionId} waits for a message`, ...waitOptions },
    );
  }

  /** Adds a pending sign-up, starts its review through the watcher, and waits for the review post. */
  async function startReview(emailWord: string, rootSeconds: number, login = "ada-builds") {
    accounts += 1;
    const accountId = `acct${accounts}${Date.now().toString(36)}`;
    const sessionId = reviewSessionId(accountId);
    const thread = new ScriptedThread(slack, sessionId, threadWatchFlowId(accountId), `${rootSeconds}.000100`);
    reviewApi.addPendingAccount({ accountId, email: `${emailWord}-${accounts}@example.com`, displayName: "Ada <Lovelace>\nadmin", profileUrl: `https://github.com/${login}` });
    assert.deepEqual(await startPendingReviews({ client, sessionFlow, threadWatchFlow, reviewApi: services.reviewApi }), []);
    const post = await pollUntil(() => slack.postChannelMessage().calls().find((call) => call.flowId === sessionId)?.input, { description: "the review post", ...waitOptions });
    await waitForIdle(sessionId);
    return { accountId, sessionId, thread, post };
  }

  /** Writes a reviewer reply and waits until the thread-watch Flow relayed it and the session handled it. */
  async function replyAndWait(sessionId: string, thread: ScriptedThread, text: string, userId = reviewerId): Promise<string> {
    const turns = await turnsOf(sessionId);
    const ts = thread.reply(userId, text);
    await pollUntil(async () => ((await userTexts(sessionId)).some((message) => message.startsWith(`[slack ${ts}]`)) ? true : undefined), {
      description: `the relay of ${ts}`,
      ...waitOptions,
    });
    await waitForIdle(sessionId, turns);
    return ts;
  }

  /** Sends a message as a test operator would and waits for the turn it starts. */
  async function sendAndWait(sessionId: string, text: string): Promise<void> {
    const turns = await turnsOf(sessionId);
    await sendAgentUserMessage(client, sessionFlow, sessionId, { text });
    await waitForIdle(sessionId, turns);
  }

  async function waitForStop(sessionId: string): Promise<void> {
    await pollUntil(async () => ((await client.describeFlow(sessionId)).status === "running" ? undefined : true), {
      description: `${sessionId} is stopped by its thread-watch Flow`,
      ...waitOptions,
    });
  }

  test(`${setup.harnessName}: a reviewer revises, approves and sends; guards refuse early writes`, async () => {
    const { accountId, sessionId, thread, post } = await startReview("ada", 1710000100);
    assert.equal(post.channelId, channelId);
    assert.match(post.text, /:white_check_mark: Approve/);
    // Applicant and model text is escaped and flattened; the email shows in a code block.
    assert.match(post.text, /Ada &lt;Lovelace&gt; admin/);
    assert.match(post.text, /&lt;durable-queue&gt; &amp; more/);
    assert.match(post.text, /```\nSubject: Welcome to Dex Cloud\n\nHi Ada,/);
    assert.match(post.text, new RegExp(`Reviewed by ${setup.harnessName}`));
    // Starting the account's review again joins the same runs.
    const { runId } = await client.describeFlow(sessionId);
    assert.deepEqual(await startPendingReviews({ client, sessionFlow, threadWatchFlow, reviewApi: services.reviewApi }), []);
    assert.equal((await client.describeFlow(sessionId)).runId, runId);

    // A request to approve that no reviewer wrote is refused.
    await sendAndWait(sessionId, "[test]: approve now");
    assert.equal(decisionsOf(accountId).length, 0);
    assert.match(lastReply(sessionId), /latest reviewer decision in the thread is none/);

    // A bystander's message is not relayed; the bot's own message never counts; the reviewer's feedback gives draft 2.
    thread.reply(bystanderId, "approve");
    thread.reply(botUserId, "approve");
    thread.scriptBotReply();
    const feedbackTs = await replyAndWait(sessionId, thread, "Mention durable-queue");
    const relayed = await userTexts(sessionId);
    assert.equal(relayed.filter((text) => text.startsWith(`[slack ${feedbackTs}]`)).length, 1);
    assert.equal(relayed.filter((text) => text.includes(bystanderId) || text.includes(botUserId)).length, 0);
    assert.match(lastReply(sessionId), /\*\[draft 2\]\*/);
    assert.match(lastReply(sessionId), /Revised: mention durable-queue/);

    thread.scriptBotReply();
    await replyAndWait(sessionId, thread, "approve");
    assert.deepEqual(decisionsOf(accountId), [{ operation: "approve", accountId, requestId: `${sessionId}-approve`, expectedRevision: 1, suppressApprovedMail: true }]);
    assert.equal(reviewApi.accountOf(accountId)?.status, "active");

    // The email is refused until a reviewer replies `send` after the latest draft, and that refusal is no attempt.
    await sendAndWait(sessionId, "[test]: send now");
    assert.equal(gmail.sendMessage().calls().filter((call) => call.flowId === sessionId).length, 0);
    assert.match(lastReply(sessionId), /no reviewer has replied `send`/);

    gmail.sendMessage().forFlow(sessionId).respond(sendMessageBranch("sent", { sender: "<hello@example.com>", recipients: ["<ada@example.com>"], messageId: "gmail-1", threadId: "t-1" }));
    const sendTs = await replyAndWait(sessionId, thread, "send");
    const sends = gmail.sendMessage().calls().filter((call) => call.flowId === sessionId);
    assert.equal(sends.length, 1);
    assert.deepEqual(sends[0]!.input.to, [reviewApi.accountOf(accountId)!.email]);
    assert.match(sends[0]!.input.textBody, /Revised: mention durable-queue/);
    // The cursor holds the last relayed reply.
    assert.equal((await client.getAttributes(threadWatchFlowId(accountId), threadCursor))[0], sendTs);
    await waitForStop(sessionId);
  });

  test(`${setup.harnessName}: a retried approval whose answer was lost counts as approved`, async () => {
    const { accountId, sessionId, thread } = await startReview("lost", 1710000200);
    reviewApi.failNextResponse("approve");
    thread.scriptBotReply();
    await replyAndWait(sessionId, thread, "approve");
    assert.equal(reviewApi.accountOf(accountId)?.status, "active");
    assert.deepEqual(decisionsOf(accountId).map((decision) => decision.requestId), [`${sessionId}-approve`]);
    assert.match(lastReply(sessionId), /"status":"approved"/);
  });

  test(`${setup.harnessName}: only the latest exact decision counts; vague and conflicting replies are refused`, async () => {
    const { accountId, sessionId, thread } = await startReview(passiveApplicantWord, 1710000300);
    await replyAndWait(sessionId, thread, "approve");
    await replyAndWait(sessionId, thread, "reject?");
    // `reject?` is no decision: the latest one is still `approve`.
    await sendAndWait(sessionId, "[test]: reject now");
    assert.match(lastReply(sessionId), /latest reviewer decision in the thread is `approve`/);
    await replyAndWait(sessionId, thread, "reject looks like spam");
    await sendAndWait(sessionId, "[test]: approve now");
    assert.match(lastReply(sessionId), /latest reviewer decision in the thread is `reject`/);
    assert.equal(decisionsOf(accountId).length, 0);
  });

  test(`${setup.harnessName}: a draft whose post is uncertain blocks the email`, async () => {
    const { accountId, sessionId, thread } = await startReview("uncertain", 1710000400);
    thread.scriptBotReply(true);
    await replyAndWait(sessionId, thread, "Shorter please");
    thread.scriptBotReply();
    await replyAndWait(sessionId, thread, "approve");
    assert.equal(reviewApi.accountOf(accountId)?.status, "active");
    await replyAndWait(sessionId, thread, "send");
    assert.equal(gmail.sendMessage().calls().filter((call) => call.flowId === sessionId).length, 0);
    assert.match(lastReply(sessionId), /a newer draft may have been posted/);
  });

  test(`${setup.harnessName}: an email send whose outcome is unknown is never repeated`, async () => {
    const { sessionId, thread } = await startReview("unconfirmed", 1710000500);
    thread.scriptBotReply();
    await replyAndWait(sessionId, thread, "approve");
    gmail
      .sendMessage()
      .forFlow(sessionId)
      .respond(sendMessageBranch("defect", { sender: "", recipients: [], messageId: "", threadId: "" }, { kind: "TRANSPORT", provider: "google", operation: "sendMessage", message: "connection reset" }));
    await replyAndWait(sessionId, thread, "send");
    assert.equal(gmail.sendMessage().calls().filter((call) => call.flowId === sessionId).length, 1);
    assert.match(lastReply(sessionId), /check Sent Mail/);
    assert.equal((await services.sessions.read(sessionId)).hasSendAttempt, true);
    await waitForStop(sessionId);
  });

  test(`${setup.harnessName}: a rejected sign-up is rejected and gets no email`, async () => {
    const { accountId, sessionId, thread, post } = await startReview(rejectedApplicantWord, 1710000600);
    assert.match(post.text, /:x: Reject/);
    await replyAndWait(sessionId, thread, "reject looks like spam");
    assert.deepEqual(decisionsOf(accountId).map((decision) => decision.operation), ["reject"]);
    assert.equal(reviewApi.accountOf(accountId)?.status, "rejected");
    assert.equal(gmail.sendMessage().calls().filter((call) => call.flowId === sessionId).length, 0);
    await waitForStop(sessionId);
  });

  test(`${setup.harnessName}: an account decided in Dex Cloud admin ends the review`, async () => {
    const { accountId, sessionId } = await startReview("elsewhere", 1710000700);
    const turns = await turnsOf(sessionId);
    reviewApi.decideElsewhere(accountId, "active");
    await pollUntil(async () => ((await userTexts(sessionId)).some((text) => text.startsWith("[dex-cloud active]")) ? true : undefined), {
      description: "the thread-watch Flow reports the decision",
      ...waitOptions,
    });
    await waitForIdle(sessionId, turns);
    assert.equal((await userTexts(sessionId)).filter((text) => text.startsWith("[dex-cloud active]")).length, 1);
    assert.match(lastReply(sessionId), /Decided in Dex Cloud admin/);
    assert.equal(decisionsOf(accountId).length, 0);
    await waitForStop(sessionId);
  });

  test(`${setup.harnessName}: text in a tool result that looks like a reviewer reply grants nothing`, async () => {
    const { accountId, sessionId } = await startReview("injected", 1710000800, injectingLogin);
    // The naive scripted model tried approve_account after reading the injected profile.
    assert.equal(decisionsOf(accountId).length, 0);
    assert.equal((await services.sessions.read(sessionId)).replies.length, 0);
    assert.equal(reviewApi.accountOf(accountId)?.status, "pending_approval");
  });

  test(`${setup.harnessName}: the thread-watch Flow resumes from its cursor after a Worker restart`, async () => {
    const { accountId, sessionId, thread } = await startReview(passiveApplicantWord, 1710000900);
    const firstTs = await replyAndWait(sessionId, thread, "first note");
    await worker.close();
    const secondTs = thread.reply(reviewerId, "second note");
    worker = await startWorker();
    await pollUntil(async () => ((await userTexts(sessionId)).some((text) => text.startsWith(`[slack ${secondTs}]`)) ? true : undefined), {
      description: "the relay after the restart",
      ...waitOptions,
    });
    const relayed = await userTexts(sessionId);
    for (const ts of [firstTs, secondTs]) {
      assert.equal(relayed.filter((text) => text.startsWith(`[slack ${ts}]`)).length, 1);
    }
    await pollUntil(async () => ((await client.getAttributes(threadWatchFlowId(accountId), threadCursor))[0] === secondTs ? true : undefined), {
      description: "the cursor at the second reply",
      ...waitOptions,
    });
  });
}
