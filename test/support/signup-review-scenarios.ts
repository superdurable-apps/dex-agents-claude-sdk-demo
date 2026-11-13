// TEST ONLY: the review scenarios every harness passes, on a private local Dex engine with connector mocks.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GmailMock, sendMessageBranch } from "@superdurable/connector-google-gmail/mock";
import type { Message as SlackMessage } from "@superdurable/connector-slack";
import { GeneratedMock, listThreadMessagesRead, postThreadReplySent, postThreadReplyUncertain, postChannelMessageSent } from "@superdurable/connector-slack/mock";
import { Client, Registry, Worker, openBlobCache, type BlobCache } from "@superdurable/dex";
import { readAgentSnapshot } from "@superdurable/dex-agents";
import { PrivateDexEngine, pollUntil } from "@superdurable/dex-agents/testing";

import { ReviewApiClient } from "../../src/review-api.js";
import { ReviewSessions, reviewPollerId, reviewSessionId, type ReviewSessionFlow } from "../../src/review-state.js";
import { SignupReviewThreadPoller, latestDraft, reportedStatus, threadCursor, threadPage } from "../../src/review-thread-poller.js";
import { type SignupServices } from "../../src/signup-agent.js";
import { startPendingReviews } from "../../src/signup-watcher.js";
import { ReviewApiTestStub } from "./review-api-test-stub.js";
import { FixtureProfileSources, multiCallApplicantWord, passiveApplicantWord, rejectedApplicantWord } from "./scripted-signup-agent.js";

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

/** A Slack thread whose replies the test writes; the poller's reads return it as it stands. */
class ScriptedThread {
  private readonly messages: SlackMessage[] = [];
  private version = 0;
  private seconds: number;

  public constructor(
    private readonly slack: GeneratedMock,
    private readonly sessionId: string,
    private readonly pollerId: string,
    public readonly rootTs: string,
  ) {
    this.seconds = Math.floor(Number(rootTs));
    slack.postChannelMessage().forFlow(sessionId).default(postChannelMessageSent({ message: { channelId, timestamp: rootTs, userId: botUserId, text: "review" } }));
    slack.postThreadReply().forFlow(sessionId).default(postThreadReplySent({ message: { channelId, timestamp: `${this.seconds}.000900`, threadTimestamp: rootTs, userId: botUserId, text: "ok" } }));
    this.publish();
  }

  /** Adds a message from `userId`; thread reads return it from now on. */
  public reply(userId: string, text: string): string {
    this.seconds += 1;
    const ts = `${this.seconds}.000200`;
    this.messages.push({ channelId, timestamp: ts, threadTimestamp: this.rootTs, userId, text });
    this.publish();
    return ts;
  }

  /** Answers the session's next thread reply as an uncertain post. */
  public failNextBotReply(): void {
    this.slack
      .postThreadReply()
      .forFlow(this.sessionId)
      .respond(postThreadReplyUncertain({ message: { channelId, timestamp: "", threadTimestamp: this.rootTs, userId: botUserId, text: "" } }, failure("postThreadReply", "lost")));
  }

  /** Publishes the thread as Slack pages it: 15 messages a page, the root first; page n > 1 has cursor `page-<n>`. */
  private publish(): void {
    this.version += 1;
    const version = this.version;
    const all: SlackMessage[] = [{ channelId, timestamp: this.rootTs, userId: botUserId, text: "review" }, ...this.messages];
    for (let page = 1; (page - 1) * 15 < all.length; page++) {
      const cursor = page === 1 ? "" : `page-${page}`;
      const hasNext = page * 15 < all.length;
      this.slack
        .listThreadMessages()
        .forFlow(this.pollerId)
        .when(
          (input) => this.version === version && (input.cursor ?? "") === cursor,
          listThreadMessagesRead({ messages: all.slice((page - 1) * 15, page * 15), ...(hasNext ? { nextCursor: `page-${page + 1}` } : {}) }),
        );
    }
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
  let pollerFlow: SignupReviewThreadPoller;
  let accounts = 0;
  // Sign-ups registered before the tests started are the backlog the watcher must leave alone.
  const reviewSince = new Date(Date.now() - 1_000);
  const watcherParts = () => ({ client, sessionFlow, reviewApi: services.reviewApi, reviewSince });

  test.before(async () => {
    engine = await PrivateDexEngine.start();
    reviewApi = await ReviewApiTestStub.start();
    slack = new GeneratedMock("review-slack");
    gmail = new GmailMock("welcome-gmail");
    services = {
      sessions: new ReviewSessions(new Set([reviewerId])),
      reviewApi: new ReviewApiClient({ baseUrl: reviewApi.baseUrl, apiKey: reviewApi.apiKey }),
      profiles: new FixtureProfileSources(),
      slack: slack.connection(),
      gmail: gmail.connection(),
      slackChannelId: channelId,
      harnessLabel: setup.harnessName,
    };
    sessionFlow = await setup.createFlow(services);
    // The poller lists the bot as a reviewer on purpose: its own posts must still never be relayed.
    pollerFlow = new SignupReviewThreadPoller({
      ...services,
      reviewerSlackIds: new Set([reviewerId, botUserId]),
      client: () => client,
      pollIntervalMs: 200,
      accountCheckEveryRounds: 3,
      roundTimeoutMs: 1_500,
    });
    registry = new Registry([sessionFlow, pollerFlow]);
    cacheDirectory = mkdtempSync(join(tmpdir(), "signup-agent-test-"));
    blobCache = openBlobCache({ directory: cacheDirectory, maxBytes: 64 * 1024 * 1024 });
    client = new Client(registry, blobCache, { serverAddress: engine.serverAddress });
    services.sessions.connect(client, sessionFlow, pollerFlow);
    worker = await startWorker();
  });

  async function startWorker(): Promise<Worker> {
    // Each open review's poller holds a slot while it polls, and most tests leave their review open.
    const started = new Worker(registry, blobCache, { serverAddress: engine.serverAddress, pull: { stopDrainTimeoutMs: 1_000, maxConcurrentTasks: 64 } });
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
  const threadReplies = (sessionId: string) => slack.postThreadReply().calls().filter((call) => call.flowId === sessionId).map((call) => call.input.text);
  const decisionsOf = (accountId: string) => reviewApi.decisions.filter((decision) => decision.accountId === accountId);
  const sendsOf = (sessionId: string) => gmail.sendMessage().calls().filter((call) => call.flowId === sessionId);
  const sent = (messageId: string) => sendMessageBranch("sent", { sender: "<hello@example.com>", recipients: ["<ada@example.com>"], messageId, threadId: "t-1" });
  const applicant = (accountId: string) => `Ada &lt;Lovelace&gt; admin 'tick' (${reviewApi.accountOf(accountId)!.email})`;

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
  async function startReview(emailWord: string, rootSeconds: number) {
    accounts += 1;
    const accountId = `acct${accounts}${Date.now().toString(36)}`;
    const sessionId = reviewSessionId(accountId);
    const thread = new ScriptedThread(slack, sessionId, reviewPollerId(accountId), `${rootSeconds}.000100`);
    reviewApi.addPendingAccount({ accountId, email: `${emailWord}-${accounts}@example.com`, displayName: "Ada <Lovelace>\nadmin `tick`", profileUrl: "https://github.com/ada-builds" });
    assert.deepEqual(await startPendingReviews(watcherParts()), []);
    const post = await pollUntil(() => slack.postChannelMessage().calls().find((call) => call.flowId === sessionId)?.input, { description: "the review post", ...waitOptions });
    await waitForIdle(sessionId);
    return { accountId, sessionId, thread, post };
  }

  /** Writes a reviewer reply and waits until the poller relayed it and the session handled it. */
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

  /** Waits until the poller stopped the session and completed. */
  async function waitForStop(accountId: string): Promise<void> {
    for (const flowId of [reviewSessionId(accountId), reviewPollerId(accountId)]) {
      await pollUntil(async () => ((await client.describeFlow(flowId)).status === "running" ? undefined : true), { description: `${flowId} stopped`, ...waitOptions });
    }
    assert.equal((await client.describeFlow(reviewPollerId(accountId))).status, "completed");
  }

  /** The results the model saw for tool `name`, oldest first. */
  const resultsOf = async (sessionId: string, name: string) => {
    const snapshot = await snapshotOf(sessionId);
    const bare = (toolName: string | null) => toolName?.split("__").at(-1);
    const stored = snapshot.messages.filter((message) => message.role === "tool" && bare(message.toolName) === name).map((message) => message.toolOutput ?? "");
    return stored.length > 0 ? stored : snapshot.toolCalls.filter((record) => bare(record.toolName) === name).map((record) => record.error ?? record.output ?? "");
  };

  test(`${setup.harnessName}: a reviewer revises, approves and sends; the tools confirm each step and the review ends`, async () => {
    const { accountId, sessionId, thread, post } = await startReview("ada", 1710000100);
    assert.equal(post.channelId, channelId);
    assert.match(post.text, /:white_check_mark: Approve/);
    // Applicant and model text is escaped and flattened; the email shows in a code block; the footer is the last line.
    assert.match(post.text, /Ada &lt;Lovelace&gt; admin 'tick'/);
    assert.match(post.text, /&lt;durable-queue&gt; &amp; more/);
    assert.match(post.text, /```\nSubject: Welcome to Dex Cloud\n\nHi Ada,/);
    assert.equal(post.text.split("\n").at(-1), `_Reviewed by ${setup.harnessName} · Dex session \`${sessionId}\`_`);
    // Starting the account's review again joins the same run.
    const { runId } = await client.describeFlow(sessionId);
    assert.deepEqual(await startPendingReviews(watcherParts()), []);
    assert.equal((await client.describeFlow(sessionId)).runId, runId);

    // A bystander's message is not relayed; the bot's own message never is; the reviewer's feedback gives draft 2.
    thread.reply(bystanderId, "approve");
    thread.reply(botUserId, "approve");
    const feedbackTs = await replyAndWait(sessionId, thread, "Mention durable-queue");
    assert.equal(decisionsOf(accountId).length, 0);
    assert.match(threadReplies(sessionId).at(-1)!, /\*\[draft 2\]\*\n```\nSubject: Welcome to Dex Cloud\n\nHi Ada,\n\nWelcome to Dex Cloud. Revised: mention durable-queue/);
    assert.match(threadReplies(sessionId).at(-1)!, /Approve the account first \(`approve`\), then reply `send`, or write what to change\.$/);

    await replyAndWait(sessionId, thread, "approve");
    assert.deepEqual(decisionsOf(accountId), [{ operation: "approve", accountId, requestId: `${sessionId}-approve`, expectedRevision: 0, suppressApprovedMail: true }]);
    assert.equal(reviewApi.accountOf(accountId)?.status, "active");
    assert.equal(threadReplies(sessionId).at(-1), `Approved ${applicant(accountId)} on Dex Cloud. Reply \`send\` to email the welcome message.`);

    // A draft after the approval says the next step is `send`.
    await replyAndWait(sessionId, thread, "Shorter");
    assert.match(threadReplies(sessionId).at(-1)!, /^\*\[draft 3\]\*\n[\s\S]*Reply `send` to send this draft, or write what to change\.$/);
    assert.equal((await client.getAttributes(reviewPollerId(accountId), latestDraft))[0]?.number, 3);

    gmail.sendMessage().forFlow(sessionId).respond(sent("gmail-1"));
    const sendTs = await replyAndWait(sessionId, thread, "send");
    assert.equal(sendsOf(sessionId).length, 1);
    assert.deepEqual(sendsOf(sessionId)[0]!.input.to, [reviewApi.accountOf(accountId)!.email]);
    assert.match(sendsOf(sessionId)[0]!.input.textBody, /Revised: shorter/);
    assert.ok(threadReplies(sessionId).includes(`Sent the welcome email to ${reviewApi.accountOf(accountId)!.email}.`));
    assert.equal((await client.getAttributes(reviewPollerId(accountId), threadCursor))[0], sendTs);
    await waitForStop(accountId);

    // Each listed reviewer's reply reached the session once; nobody else's did, and the agent's own approval was not
    // reported as a decision made in Dex Cloud admin.
    const relayed = await userTexts(sessionId);
    assert.equal(relayed.filter((text) => text.startsWith(`[slack ${feedbackTs}]`)).length, 1);
    assert.equal(relayed.filter((text) => text.startsWith("[slack ")).length, 4);
    assert.equal(relayed.filter((text) => text.includes(bystanderId) || text.includes(botUserId)).length, 0);
    assert.equal(relayed.filter((text) => text.startsWith("[dex-cloud")).length, 0);
  });

  test(`${setup.harnessName}: an approval the server refuses posts the failure in the thread`, async () => {
    const { accountId, sessionId, thread } = await startReview("nomail", 1710000170);
    reviewApi.refusesSuppressedMail = true;
    try {
      await replyAndWait(sessionId, thread, "approve");
    } finally {
      reviewApi.refusesSuppressedMail = false;
    }
    assert.equal(reviewApi.accountOf(accountId)?.status, "pending_approval");
    assert.equal(threadReplies(sessionId).at(-1), "Approval failed: the review API refused the decision: ReviewAPI approve: suppressApprovedMail is not supported yet.");
    assert.match((await resultsOf(sessionId, "approve_account")).at(-1) ?? "", /approve_account failed: .*suppressApprovedMail is not supported yet/);
  });

  test(`${setup.harnessName}: an approval whose answer was lost is tried again and counts as approved`, async () => {
    const { accountId, sessionId, thread } = await startReview("lost", 1710000200);
    reviewApi.failNextResponse("approve");
    await replyAndWait(sessionId, thread, "approve");
    assert.equal(reviewApi.accountOf(accountId)?.status, "active");
    assert.deepEqual(decisionsOf(accountId).map((decision) => decision.requestId), [`${sessionId}-approve`]);
    assert.match(threadReplies(sessionId).at(-1)!, /^Approved /);
  });

  test(`${setup.harnessName}: a confirmation that fails to post leaves the approval as it is`, async () => {
    const { accountId, sessionId, thread } = await startReview("lostpost", 1710000250);
    thread.failNextBotReply();
    await replyAndWait(sessionId, thread, "approve");
    assert.equal(reviewApi.accountOf(accountId)?.status, "active");
    assert.match((await resultsOf(sessionId, "approve_account")).at(-1) ?? "", /"status":"approved"/);
  });

  test(`${setup.harnessName}: a rejected sign-up is rejected with the reason in the thread and gets no email`, async () => {
    const { accountId, sessionId, thread, post } = await startReview(rejectedApplicantWord, 1710000600);
    assert.match(post.text, /:x: Reject/);
    await replyAndWait(sessionId, thread, "reject Looks like <spam>");
    assert.deepEqual(decisionsOf(accountId).map((decision) => decision.operation), ["reject"]);
    assert.equal(reviewApi.accountOf(accountId)?.status, "rejected");
    assert.ok(threadReplies(sessionId).includes(`Rejected ${applicant(accountId)}: Looks like &lt;spam&gt;.`));
    assert.equal(sendsOf(sessionId).length, 0);
    await waitForStop(accountId);
  });

  test(`${setup.harnessName}: a rejection the server refuses posts the failure in the thread`, async () => {
    const { accountId, sessionId, thread } = await startReview("lockedreject", 1710000650);
    reviewApi.refuseNext("reject");
    await replyAndWait(sessionId, thread, "reject looks like spam");
    assert.equal(reviewApi.accountOf(accountId)?.status, "pending_approval");
    assert.equal(threadReplies(sessionId).at(-1), "Rejection failed: the review API refused the decision: ReviewAPI reject: the account is locked.");
  });

  test(`${setup.harnessName}: a send that fails says so in the thread, and the review ends`, async () => {
    const { accountId, sessionId, thread } = await startReview("unconfirmed", 1710000500);
    await replyAndWait(sessionId, thread, "approve");
    gmail
      .sendMessage()
      .forFlow(sessionId)
      .respond(sendMessageBranch("defect", { sender: "", recipients: [], messageId: "", threadId: "" }, { kind: "TRANSPORT", provider: "google", operation: "sendMessage", message: "connection reset" }));
    await replyAndWait(sessionId, thread, "send");
    assert.equal(sendsOf(sessionId).length, 1);
    assert.ok(threadReplies(sessionId).includes("Sending the welcome email failed: connection reset. Check Sent Mail; if nothing went out, send it manually."));
    await waitForStop(accountId);
  });

  test(`${setup.harnessName}: a send before the approval is refused and sends nothing`, async () => {
    const { sessionId, thread } = await startReview("early", 1710000550);
    await replyAndWait(sessionId, thread, "send");
    assert.equal(sendsOf(sessionId).length, 0);
    assert.match((await resultsOf(sessionId, "send_welcome_email")).at(-1) ?? "", /refused: the account is pending_approval, not approved/);
  });

  test(`${setup.harnessName}: several tool calls in one model response keep their order`, async () => {
    const { sessionId, thread } = await startReview(multiCallApplicantWord, 1710000370);
    await replyAndWait(sessionId, thread, "Shorter");
    // pi runs both calls in order; the Claude Code CLI runs one deferred call per segment and may drop the second.
    const firstLines = threadReplies(sessionId).map((text) => text.split("\n")[0]);
    assert.equal(firstLines.filter((line) => line === "*[draft 2]*").length, 1);
    assert.ok(!firstLines.includes("Here is the new draft.") || firstLines.indexOf("Here is the new draft.") > firstLines.indexOf("*[draft 2]*"));
    await replyAndWait(sessionId, thread, "approve");
    gmail.sendMessage().forFlow(sessionId).respond(sent("gmail-multi"));
    await replyAndWait(sessionId, thread, "send");
    assert.equal(sendsOf(sessionId).length, 1);
    // The draft posted beside another call is the one sent.
    assert.match(sendsOf(sessionId)[0]!.input.textBody, /Revised: shorter/);
  });

  test(`${setup.harnessName}: an account decided in Dex Cloud admin ends the review, through a busy ReviewAPI`, async () => {
    const { accountId, sessionId } = await startReview("elsewhere", 1710000700);
    const turns = await turnsOf(sessionId);
    reviewApi.decideElsewhere(accountId, "active");
    // A 503 skips a round of the poller; it neither fails nor ends it.
    reviewApi.failingGets = 2;
    await pollUntil(async () => ((await userTexts(sessionId)).some((text) => text.startsWith("[dex-cloud active]")) ? true : undefined), {
      description: "the poller reports the decision",
      ...waitOptions,
    });
    await waitForIdle(sessionId, turns);
    assert.equal((await userTexts(sessionId)).filter((text) => text.startsWith("[dex-cloud active]")).length, 1);
    assert.match(threadReplies(sessionId).at(-1)!, /Decided in Dex Cloud admin/);
    assert.equal(decisionsOf(accountId).length, 0);
    await waitForStop(accountId);
  });

  test(`${setup.harnessName}: sign-ups registered before SIGNUP_REVIEW_SINCE are left alone`, async () => {
    const accountId = `acctold${Date.now().toString(36)}`;
    reviewApi.addPendingAccount({ accountId, email: "old@example.com", registeredAt: "2020-01-01T00:00:00Z" });
    assert.deepEqual(await startPendingReviews(watcherParts()), []);
    await assert.rejects(client.describeFlow(reviewSessionId(accountId)));
  });

  test(`${setup.harnessName}: the poller resumes after a Worker restart and relays each reply once`, async () => {
    const { sessionId, thread } = await startReview(passiveApplicantWord, 1710000900);
    const firstTs = await replyAndWait(sessionId, thread, "first note");
    await worker.close();
    const secondTs = thread.reply(reviewerId, "second note");
    worker = await startWorker();
    await pollUntil(async () => ((await userTexts(sessionId)).some((text) => text.startsWith(`[slack ${secondTs}]`)) ? true : undefined), {
      description: "the relay after the Worker restart",
      ...waitOptions,
    });
    const relayed = await userTexts(sessionId);
    for (const ts of [firstTs, secondTs]) {
      assert.equal(relayed.filter((text) => text.startsWith(`[slack ${ts}]`)).length, 1);
    }
  });

  test(`${setup.harnessName}: a round abandoned by its timeout writes nothing`, async () => {
    const { accountId, sessionId } = await startReview("slowround", 1710001600);
    reviewApi.decideElsewhere(accountId, "active");
    // Every account read takes longer than a round may: each such round is abandoned before it reports.
    reviewApi.getDelayMs = 3_000;
    try {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      assert.equal((await client.getAttributes(reviewPollerId(accountId), reportedStatus))[0], undefined);
      assert.equal((await userTexts(sessionId)).filter((text) => text.startsWith("[dex-cloud")).length, 0);
    } finally {
      reviewApi.getDelayMs = 0;
    }
    await pollUntil(async () => ((await userTexts(sessionId)).some((text) => text.startsWith("[dex-cloud active]")) ? true : undefined), {
      description: "the report once rounds are fast again",
      ...waitOptions,
    });
    assert.equal((await userTexts(sessionId)).filter((text) => text.startsWith("[dex-cloud active]")).length, 1);
  });

  test(`${setup.harnessName}: the poller reads one thread page a round and moves on when a page is full`, async () => {
    const { accountId, sessionId, thread } = await startReview(passiveApplicantWord, 1710001700);
    // 15 bystander messages fill the first page with the root; the reviewer's reply lands on page 2.
    for (let index = 0; index < 15; index++) {
      thread.reply(bystanderId, `chatter ${index}`);
    }
    const replyTs = await replyAndWait(sessionId, thread, "a note on page two");
    assert.equal((await client.getAttributes(reviewPollerId(accountId), threadPage))[0], "page-2");
    const reads = slack.listThreadMessages().calls().filter((call) => call.flowId === reviewPollerId(accountId));
    const firstOnPageTwo = reads.findIndex((call) => call.input.cursor === "page-2");
    assert.ok(firstOnPageTwo > 0);
    // Once on page 2, no round reads the thread from its start again.
    assert.ok(reads.slice(firstOnPageTwo).every((call) => call.input.cursor === "page-2"));
    assert.ok(reads.every((call) => call.input.pageSize === 15));
    assert.deepEqual((await userTexts(sessionId)).filter((text) => text.startsWith("[slack ")).map((text) => text.split("]")[0]), [`[slack ${replyTs}`]);
  });
}
