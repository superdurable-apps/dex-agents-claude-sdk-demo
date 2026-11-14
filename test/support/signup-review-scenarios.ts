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
import { readAgentSnapshot, sendAgentUserMessage } from "@superdurable/dex-agents";
import { PrivateDexEngine, pollUntil } from "@superdurable/dex-agents/testing";

import { ReviewApiClient } from "../../src/review-api.js";
import { ReviewSessions, reviewPollerId, reviewSessionId, type ReviewSessionFlow } from "../../src/review-state.js";
import { SignupReviewThreadPoller, latestDraft, threadCursor, threadPage } from "../../src/review-thread-poller.js";
import { type SignupServices } from "../../src/signup-agent.js";
import { startPendingReviews } from "../../src/signup-watcher.js";
import { ReviewApiTestStub } from "./review-api-test-stub.js";
import { FixtureProfileSources, firstTurnFailingWord, laterTurnFailingWord, multiCallApplicantWord, passiveApplicantWord, rejectedApplicantWord } from "./scripted-signup-agent.js";

const reviewerId = "UREVIEWER1";
const bystanderId = "UBYSTANDER";
const botUserId = "UBOT0000001";
const channelId = "CREVIEWS01";
const waitOptions = { timeoutMs: 120_000, intervalMs: 200 };
/** The first retry of a failed turn waits this long in the tests. */
const retryDelayMs = 300;
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
    // The poller's own notes land in the thread, as the app's messages, so its later reads see them.
    slack
      .postThreadReply()
      .forFlow(pollerId)
      .when(
        (input) => {
          this.reply(botUserId, input.text);
          return true;
        },
        postThreadReplySent({ message: { channelId, timestamp: `${this.seconds}.000800`, threadTimestamp: rootTs, userId: botUserId, text: "note" } }),
      );
    this.publish();
  }

  /** The notes the poller posted in this thread. */
  public pollerNotes(): string[] {
    return this.slack.postThreadReply().calls().filter((call) => call.flowId === this.pollerId).map((call) => call.input.text);
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
  const watcherParts = () => ({ client, sessionFlow, sessions: services.sessions, reviewApi: services.reviewApi, reviewSince, firstRetryDelayMs: retryDelayMs });

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
      firstRetryDelayMs: retryDelayMs,
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

  /** Waits until the session finished more than `afterTurns` turns and waits for the next message, or has ended. */
  async function waitForIdle(sessionId: string, afterTurns = 0): Promise<void> {
    await pollUntil(
      async () => {
        // finish_review ends the session inside its turn, so an ended session is done too.
        if ((await client.describeFlow(sessionId)).status !== "running") {
          return true;
        }
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
    // A first turn that fails is retried by the watcher's later rounds, which a test of that runs here.
    const post = await pollUntil(
      async () => {
        const found = slack.postChannelMessage().calls().find((call) => call.flowId === sessionId)?.input;
        if (found === undefined && emailWord.includes(firstTurnFailingWord)) {
          assert.deepEqual(await startPendingReviews(watcherParts()), []);
        }
        return found;
      },
      { description: "the review post", ...waitOptions },
    );
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

  /** Sends a message to the session directly, as a test operator would, and waits for the turn it starts. */
  async function sendAndWait(sessionId: string, text: string): Promise<void> {
    const turns = await turnsOf(sessionId);
    await sendAgentUserMessage(client, sessionFlow, sessionId, { text });
    await waitForIdle(sessionId, turns);
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

    // Each listed reviewer's reply reached the session once and nobody else's did; the agent's own approval may have
    // been reported once as `[dex-cloud active]`, which changed nothing.
    const relayed = await userTexts(sessionId);
    assert.equal(relayed.filter((text) => text.startsWith(`[slack ${feedbackTs}]`)).length, 1);
    assert.equal(relayed.filter((text) => text.startsWith("[slack ")).length, 4);
    assert.equal(relayed.filter((text) => text.includes(bystanderId) || text.includes(botUserId)).length, 0);
    assert.ok(relayed.filter((text) => text.startsWith("[dex-cloud")).every((text) => text.startsWith("[dex-cloud active]")));
    assert.ok(relayed.filter((text) => text.startsWith("[dex-cloud active]")).length <= 1);
    assert.ok(!threadReplies(sessionId).some((text) => /Decided in Dex Cloud admin/.test(text)));
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

  test(`${setup.harnessName}: an applied approval whose answer was lost, with the ReviewAPI busy since, is an unknown outcome`, async () => {
    const { accountId, sessionId, thread } = await startReview("busyafter", 1710000210);
    // The approval is applied, its answer lost, and every account read after it is busy, so each retry fails.
    reviewApi.failNextResponse("approve", 1_000);
    try {
      await replyAndWait(sessionId, thread, "approve");
    } finally {
      reviewApi.failingGets = 0;
    }
    assert.equal(reviewApi.accountOf(accountId)?.status, "active");
    assert.equal(decisionsOf(accountId).length, 1);
    assert.equal(threadReplies(sessionId).at(-1), "Approval outcome unknown: ReviewAPI get: busy. Check the account in Dex Cloud admin; the review continues.");
    assert.ok(!threadReplies(sessionId).some((text) => text.startsWith("Approval failed")));
    // The model is told the outcome is unknown, not that the approval failed.
    assert.match((await resultsOf(sessionId, "approve_account")).at(-1) ?? "", /outcome (is )?unknown/);
    assert.equal((await client.describeFlow(sessionId)).status, "running");
    // Once the ReviewAPI answers again, `[dex-cloud active]` shows the approval took effect: the review goes on to the email.
    await pollUntil(async () => ((await userTexts(sessionId)).some((text) => text.startsWith("[dex-cloud active]")) ? true : undefined), {
      description: "the poller reports the active account",
      ...waitOptions,
    });
    await waitForIdle(sessionId);
    assert.equal((await client.describeFlow(sessionId)).status, "running");
    assert.ok(!threadReplies(sessionId).some((text) => /Decided in Dex Cloud admin/.test(text)));
    gmail.sendMessage().forFlow(sessionId).respond(sent("gmail-after-unknown"));
    await replyAndWait(sessionId, thread, "send");
    assert.equal(sendsOf(sessionId).length, 1);
    await waitForStop(accountId);
  });

  test(`${setup.harnessName}: a [slack <ts>] message that arrives twice is handled once`, async () => {
    const { sessionId, thread } = await startReview("twice", 1710000230);
    const drafts = () => threadReplies(sessionId).filter((text) => text.startsWith("*[draft ")).length;
    const ts = await replyAndWait(sessionId, thread, "Shorter");
    assert.equal(drafts(), 1);
    // The same relay again, as an overlap of two ForwardReplies attempts could deliver it.
    await sendAndWait(sessionId, `[slack ${ts}] <@${reviewerId}>: Shorter`);
    assert.equal(drafts(), 1);
  });

  test(`${setup.harnessName}: a first turn that fails is retried with a back-off and the review completes`, async () => {
    const { accountId, sessionId, thread } = await startReview(firstTurnFailingWord, 1710000240);
    // The first turn and the first retry failed; the second retry posted the review.
    const retries = (await userTexts(sessionId)).filter((text) => text.startsWith("[retry turn-"));
    assert.deepEqual(retries.map((text) => text.split("]")[0]), ["[retry turn-1", "[retry turn-2"]);
    assert.match(retries[0]!, /^\[retry turn-1\] The previous turn failed \(.+\)\. Handle this message again as new, then continue the review from where you left off:\nReview Dex Cloud account /);
    // No thread existed while it failed, so nothing was posted in one.
    assert.deepEqual(thread.pollerNotes(), []);
    await replyAndWait(sessionId, thread, "approve");
    gmail.sendMessage().forFlow(sessionId).respond(sent("gmail-retried"));
    await replyAndWait(sessionId, thread, "send");
    assert.equal(sendsOf(sessionId).length, 1);
    await waitForStop(accountId);
  });

  test(`${setup.harnessName}: a later turn that fails is reported once in the thread and retried`, async () => {
    const { sessionId, thread } = await startReview(laterTurnFailingWord, 1710000245);
    const turns = await turnsOf(sessionId);
    const ts = thread.reply(reviewerId, "Shorter");
    // The failed turn is retried, and the retry handles the reviewer's message: draft 2.
    await pollUntil(async () => (threadReplies(sessionId).some((text) => text.startsWith("*[draft 2]*")) ? true : undefined), { description: "draft 2 after the retry", ...waitOptions });
    await waitForIdle(sessionId, turns + 1);
    const failureNotes = thread.pollerNotes().filter((text) => text.startsWith("The agent's last turn failed: "));
    assert.equal(failureNotes.length, 1);
    assert.match(failureNotes[0]!, /It retries automatically; you can also reply here to retry now\.$/);
    const texts = await userTexts(sessionId);
    assert.equal(texts.filter((text) => text.startsWith("[retry turn-")).length, 1);
    assert.equal(texts.filter((text) => text.startsWith(`[slack ${ts}]`)).length, 1);
    assert.equal(threadReplies(sessionId).filter((text) => text.startsWith("*[draft ")).length, 1);
  });

  test(`${setup.harnessName}: someone who is not a listed reviewer gets one hint and is not relayed`, async () => {
    const { sessionId, thread } = await startReview(passiveApplicantWord, 1710000250);
    const hint = `<@${bystanderId}>, only listed reviewers' replies are read; ask an admin to add you to SIGNUP_REVIEWER_SLACK_IDS.`;
    thread.reply(bystanderId, "approve please");
    await pollUntil(() => (thread.pollerNotes().includes(hint) ? true : undefined), { description: "the hint", ...waitOptions });
    // A second reply from the same person gets no second hint; a reviewer's reply after it is still relayed.
    thread.reply(bystanderId, "hello?");
    await replyAndWait(sessionId, thread, "a note");
    assert.deepEqual(thread.pollerNotes().filter((text) => text.includes("only listed reviewers")), [hint]);
    assert.equal((await userTexts(sessionId)).filter((text) => text.includes(bystanderId)).length, 0);
  });

  test(`${setup.harnessName}: the agent's own approval reported as [dex-cloud active], once, does no harm, even after a hold`, async () => {
    const { accountId, sessionId, thread } = await startReview("heldapproval", 1710000220);
    await replyAndWait(sessionId, thread, "approve");
    assert.equal(reviewApi.accountOf(accountId)?.status, "active");
    await replyAndWait(sessionId, thread, "hold");
    await pollUntil(async () => ((await userTexts(sessionId)).some((text) => text.startsWith("[dex-cloud active]")) ? true : undefined), {
      description: "the poller reports the active account",
      ...waitOptions,
    });
    // Many account checks later the notice is still there once, and the session still waits for `send`.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await waitForIdle(sessionId);
    assert.equal((await userTexts(sessionId)).filter((text) => text.startsWith("[dex-cloud")).length, 1);
    assert.equal((await client.describeFlow(sessionId)).status, "running");
    assert.ok(!threadReplies(sessionId).some((text) => /Decided in Dex Cloud admin/.test(text)));
    gmail.sendMessage().forFlow(sessionId).respond(sent("gmail-held"));
    await replyAndWait(sessionId, thread, "send");
    assert.equal(sendsOf(sessionId).length, 1);
    await waitForStop(accountId);
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

  test(`${setup.harnessName}: a send Gmail rejects is a definite failure: nothing was sent`, async () => {
    const { accountId, sessionId, thread } = await startReview("gmailoff", 1710000520);
    await replyAndWait(sessionId, thread, "approve");
    gmail
      .sendMessage()
      .forFlow(sessionId)
      .respond(sendMessageBranch("providerRejected", { sender: "", recipients: [], messageId: "", threadId: "" }, { kind: "AUTHORIZATION", provider: "google", operation: "sendMessage", message: "Gmail rejected the message" }));
    await replyAndWait(sessionId, thread, "send");
    assert.equal(sendsOf(sessionId).length, 1);
    assert.ok(threadReplies(sessionId).includes("Sending the welcome email failed: Gmail rejected the message (AUTHORIZATION). Nothing was sent."));
    assert.ok(!threadReplies(sessionId).some((text) => /Check Sent Mail/.test(text)));
    // Recorded as failed with the reason, not as an unknown outcome.
    assert.match((await resultsOf(sessionId, "send_welcome_email")).at(-1) ?? "", /send_welcome_email failed and nothing was sent: Gmail rejected the message \(AUTHORIZATION\)/);
    await waitForStop(accountId);
  });

  test(`${setup.harnessName}: a draft the same as the latest one is refused`, async () => {
    const { sessionId, thread } = await startReview("samedraft", 1710000540);
    const drafts = () => threadReplies(sessionId).filter((text) => text.startsWith("*[draft ")).length;
    await replyAndWait(sessionId, thread, "Shorter");
    assert.equal(drafts(), 1);
    // The same feedback again makes the scripted model write the same draft.
    await replyAndWait(sessionId, thread, "Shorter");
    assert.equal(drafts(), 1);
    assert.match((await resultsOf(sessionId, "post_draft")).at(-1) ?? "", /refused: this draft is the same as draft 2/);
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
