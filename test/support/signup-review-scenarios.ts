// TEST ONLY: the review scenarios every harness passes, against a private local Dex engine and connector mocks.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GmailMock, sendMessageBranch } from "@superdurable/connector-google-gmail/mock";
import type { Message as SlackMessage } from "@superdurable/connector-slack";
import {
  GeneratedMock,
  listThreadMessagesRead,
  postChannelMessageRetry,
  postChannelMessageSent,
  postThreadReplySent,
  postThreadReplyUncertain,
} from "@superdurable/connector-slack/mock";
import { stringCodec } from "@superdurable/dex";
import { readAgentSnapshot } from "@superdurable/dex-agents";
import { PrivateDexEngine, pollUntil } from "@superdurable/dex-agents/testing";

import type { SignupAgentSessionFlow } from "../../src/agent/review-submission.js";
import { SignupAgentTools } from "../../src/agent/signup-agent-tools.js";
import { startSignupApplication, type SignupApplication } from "../../src/application.js";
import { ConnectionName } from "../../src/config.js";
import { ReviewApiClient } from "../../src/review-api/review-api-client.js";
import {
  accountAttribute,
  agentSessionId,
  decisionAttribute,
  draftAttribute,
  emailAttribute,
  phaseAttribute,
  reviewAttribute,
  signupReviewFlowId,
} from "../../src/signup-review/signup-review-flow.js";
import { Phase, type AgentHarness } from "../../src/signup-review/signup-review-values.js";
import { SignupWatcher } from "../../src/signup-watcher.js";
import { ReviewApiTestStub } from "./review-api-test-stub.js";
import { FixtureProfileSources, forgetfulApplicantWord, rejectedApplicantWord } from "./signup-agent-script.js";

const reviewerId = "UREVIEWER1";
const bystanderId = "UBYSTANDER";
const botUserId = "UBOT0000001";
const channelId = "CREVIEWS01";
const waitOptions = { timeoutMs: 120_000, intervalMs: 200 };

/** How a harness test builds its agent session Flow. */
export interface SignupReviewScenarioSetup {
  readonly harnessName: string;
  readonly harness: AgentHarness;
  createAgentFlow(tools: SignupAgentTools): SignupAgentSessionFlow | Promise<SignupAgentSessionFlow>;
  close?(): Promise<void>;
}

/** A Slack thread whose replies the test writes; the mock returns the thread as it stands. */
class ScriptedThread {
  private readonly messages: SlackMessage[] = [];
  private version = 0;
  private nextTs: number;

  public constructor(
    private readonly slack: GeneratedMock,
    private readonly flowId: string,
    public readonly rootTs: string,
  ) {
    this.nextTs = Math.floor(Number(rootTs));
    slack.postChannelMessage().forFlow(flowId).default(postChannelMessageSent({ message: this.root("posted") }));
    slack
      .postThreadReply()
      .forFlow(flowId)
      .default(postThreadReplySent({ message: { channelId, timestamp: `${this.nextTs + 900}.000001`, threadTimestamp: rootTs, userId: botUserId, text: "ok" } }));
    this.publish();
  }

  private root(text: string): SlackMessage {
    return { channelId, timestamp: this.rootTs, userId: botUserId, text };
  }

  /** Adds a reply from `userId`; the next thread read returns it. */
  public reply(userId: string, text: string): string {
    this.nextTs += 1;
    const ts = `${this.nextTs}.000200`;
    this.messages.push({ channelId, timestamp: ts, threadTimestamp: this.rootTs, userId, text });
    this.publish();
    return ts;
  }

  /** Adds one of the bot's own messages, such as a reply whose post outcome was uncertain. */
  public addBotMessage(text: string): void {
    this.nextTs += 1;
    this.messages.push({ channelId, timestamp: `${this.nextTs}.000300`, threadTimestamp: this.rootTs, userId: botUserId, text });
    this.publish();
  }

  private publish(): void {
    this.version += 1;
    const version = this.version;
    const snapshot = [this.root("posted"), ...this.messages];
    this.slack
      .listThreadMessages()
      .forFlow(this.flowId)
      .when(() => this.version === version, listThreadMessagesRead({ messages: snapshot }));
  }
}

/**
 * Registers the scenarios: approve with one revision and send; reject; superseded twice (decided elsewhere, and a
 * conflicting approval); a retried root post and an uncertain thread reply that is found by its marker.
 */
export function registerSignupReviewScenarios(setup: SignupReviewScenarioSetup): void {
  let engine: PrivateDexEngine;
  let reviewApi: ReviewApiTestStub;
  let slack: GeneratedMock;
  let gmail: GmailMock;
  let application: SignupApplication;
  let watcher: SignupWatcher;
  let blobCacheDirectory: string;
  let sources: FixtureProfileSources;
  let accountCounter = 0;
  let agentFlow: SignupAgentSessionFlow;

  test.before(async () => {
    engine = await PrivateDexEngine.start();
    reviewApi = await ReviewApiTestStub.start();
    slack = new GeneratedMock(ConnectionName.slack);
    gmail = new GmailMock(ConnectionName.gmail);
    sources = new FixtureProfileSources();
    agentFlow = await setup.createAgentFlow(new SignupAgentTools(sources));
    blobCacheDirectory = mkdtempSync(join(tmpdir(), "signup-agent-test-cache-"));
    const reviewApiClient = new ReviewApiClient({ baseUrl: reviewApi.baseUrl, apiKey: reviewApi.apiKey });
    application = await startSignupApplication(
      { serverAddress: engine.serverAddress, flowServiceTls: undefined, credential: undefined, blobCacheDirectory },
      {
        reviewApi: reviewApiClient,
        slack: slack.connection(),
        gmail: gmail.connection(),
        agentSessionFlows: new Map([[setup.harness, agentFlow]]),
        slackChannelId: channelId,
        reviewerSlackIds: new Set([reviewerId]),
        timing: { agentPollIntervalMs: 200, threadPollIntervalMs: 300, accountCheckEveryRounds: 3 },
      },
    );
    watcher = new SignupWatcher(application.client, application.signupReviewFlow, reviewApiClient, {
      intervalMs: 60_000,
      harness: setup.harness,
      log: () => undefined,
    });
  });

  test.after(async () => {
    await application?.stop();
    await engine?.stop();
    await reviewApi?.stop();
    await setup.close?.();
    rmSync(blobCacheDirectory, { recursive: true, force: true });
    slack.assertNoFailures();
  });

  /** Adds a pending sign-up, starts its review through the watcher, and scripts its Slack thread. */
  async function startReview(emailWord: string, rootSeconds: number): Promise<{ accountId: string; flowId: string; thread: ScriptedThread }> {
    accountCounter += 1;
    const accountId = `acct${setup.harness.replace(/[^a-z]/g, "")}${accountCounter}${Date.now().toString(36)}`;
    const flowId = signupReviewFlowId(accountId);
    const thread = new ScriptedThread(slack, flowId, `${rootSeconds}.000100`);
    reviewApi.addPendingAccount({
      accountId,
      email: `${emailWord}-${accountCounter}@example.com`,
      displayName: "Ada Lovelace",
      profileUrl: "https://github.com/ada-builds",
      signupMethod: "password",
    });
    const started = await watcher.runRound();
    assert.ok(started.includes(accountId), `the watcher started ${started.join(", ")}`);
    return { accountId, flowId, thread };
  }

  async function waitForPhase(flowId: string, phase: string): Promise<void> {
    await pollUntil(
      async () => ((await application.client.getAttributes(flowId, phaseAttribute))[0] === phase ? true : undefined),
      { description: `${flowId} in phase ${phase}`, ...waitOptions },
    );
  }

  async function waitForThreadReply(flowId: string, includes: string): Promise<string> {
    return pollUntil(
      () =>
        slack
          .postThreadReply()
          .calls()
          .find((call) => call.flowId === flowId && call.input.text.includes(includes))?.input.text,
      { description: `a thread reply of ${flowId} with "${includes}"`, ...waitOptions },
    );
  }

  async function waitForCompletion(flowId: string): Promise<string> {
    const result = await pollUntil(
      async () => {
        try {
          return await application.client.waitForFlow(flowId, 5_000);
        } catch {
          return undefined;
        }
      },
      { description: `${flowId} completes`, ...waitOptions },
    );
    assert.equal(result.status, "completed");
    return String(result.singleOutput(stringCodec));
  }

  test(`${setup.harnessName}: an approved sign-up gets one revision and the email is sent once`, async () => {
    const { accountId, flowId, thread } = await startReview("ada", 1710000100);
    await waitForPhase(flowId, Phase.awaitingAccountDecision);
    // The watcher never starts a second review for the same account.
    assert.deepEqual(await watcher.runRound(), []);

    const rootPosts = slack.postChannelMessage().calls().filter((call) => call.flowId === flowId);
    assert.equal(rootPosts.length, 1);
    const post = rootPosts[0]!.input;
    assert.equal(post.channelId, channelId);
    assert.match(post.text, /Agent recommendation:\* :white_check_mark: Approve/);
    assert.match(post.text, /durable-queue/);
    assert.match(post.text, /Welcome email draft v1/);
    assert.match(post.text, new RegExp(`Reviewed by:\\* ${setup.harness === "pi" ? "pi" : "Claude Agent SDK"}`));
    assert.match(post.text, new RegExp(flowId));
    assert.ok(sources.calls.includes("github ada-builds"));
    const [review] = await application.client.getAttributes(flowId, reviewAttribute);
    assert.equal(review?.recommendation, "approve");

    // A bystander's "approve" is ignored; the reviewer's feedback produces draft 2.
    thread.reply(bystanderId, "approve");
    thread.reply(reviewerId, "Mention their durable-queue project");
    const draftReply = await waitForThreadReply(flowId, "Welcome email draft v2");
    assert.match(draftReply, /Revised: Mention their durable-queue project/);
    assert.match(draftReply, new RegExp(`\\[signup-review-${accountId} #1\\]`));
    assert.equal(reviewApi.decisions.filter((decision) => decision.accountId === accountId).length, 0);

    thread.reply(reviewerId, "approve");
    await waitForThreadReply(flowId, `Approved by <@${reviewerId}>`);
    const decisions = reviewApi.decisions.filter((decision) => decision.accountId === accountId);
    assert.equal(decisions.length, 1);
    assert.deepEqual(decisions[0], {
      operation: "approve",
      accountId,
      requestId: `${flowId}-approve-r1`,
      expectedRevision: 1,
      suppressApprovedMail: true,
    });
    assert.equal(reviewApi.accountOf(accountId)?.status, "active");
    const [decision] = await application.client.getAttributes(flowId, decisionAttribute);
    assert.equal(decision?.slackUserId, reviewerId);

    gmail.sendMessage().forFlow(flowId).respond(
      sendMessageBranch("sent", { sender: "<hello@example.com>", recipients: [`<ada-1@example.com>`], messageId: "gmail-1", threadId: "t-1" }),
    );
    thread.reply(reviewerId, "send");
    assert.equal(await waitForCompletion(flowId), Phase.done);

    const sends = gmail.sendMessage().calls().filter((call) => call.flowId === flowId);
    assert.equal(sends.length, 1);
    const [draft, email, account] = await application.client.getAttributes(flowId, draftAttribute, emailAttribute, accountAttribute);
    assert.equal(draft?.version, 2);
    assert.deepEqual(sends[0]!.input.to, [account!.email]);
    assert.equal(sends[0]!.input.subject, draft!.subject);
    assert.equal(sends[0]!.input.textBody, draft!.body);
    assert.equal(email?.gmailMessageId, "gmail-1");
    await waitForThreadReply(flowId, "Sent the welcome email (draft v2)");
    await assertSessionClosed(flowId);
  });

  test(`${setup.harnessName}: a rejected sign-up gets a reminder, is rejected, and sends no email`, async () => {
    const { accountId, flowId, thread } = await startReview(`${rejectedApplicantWord}-${forgetfulApplicantWord}`, 1710000200);
    await waitForPhase(flowId, Phase.awaitingAccountDecision);
    const post = slack.postChannelMessage().calls().find((call) => call.flowId === flowId)!.input;
    assert.match(post.text, /:x: Reject/);
    // The first turn ended without submit_review, so the Flow sent one reminder, and that turn submitted.
    const snapshot = await readAgentSnapshot(application.client, agentFlow, agentSessionId(flowId));
    const userTexts = snapshot.messages.filter((message) => message.role === "user").map((message) => message.text ?? "");
    assert.equal(userTexts.filter((text) => text.startsWith("[draft 1 reminder]")).length, 1);
    assert.match(post.text, /disposable/);

    thread.reply(reviewerId, "reject looks like spam");
    assert.equal(await waitForCompletion(flowId), Phase.rejected);
    const decisions = reviewApi.decisions.filter((decision) => decision.accountId === accountId);
    assert.deepEqual(decisions.map((decision) => decision.operation), ["reject"]);
    assert.equal(reviewApi.accountOf(accountId)?.status, "rejected");
    await waitForThreadReply(flowId, "Rejected by");
    assert.equal(gmail.sendMessage().calls().filter((call) => call.flowId === flowId).length, 0);
    await assertSessionClosed(flowId);
  });

  test(`${setup.harnessName}: a sign-up decided in Dex Cloud admin ends the review as superseded`, async () => {
    const { accountId, flowId } = await startReview("elsewhere", 1710000300);
    await waitForPhase(flowId, Phase.awaitingAccountDecision);
    reviewApi.decideElsewhere(accountId, "active");
    assert.equal(await waitForCompletion(flowId), Phase.superseded);
    await waitForThreadReply(flowId, "already decided in Dex Cloud admin (status: active)");
    assert.equal(reviewApi.decisions.filter((decision) => decision.accountId === accountId).length, 0);
  });

  test(`${setup.harnessName}: an approval that conflicts with a decision elsewhere ends as superseded`, async () => {
    const { accountId, flowId, thread } = await startReview("conflict", 1710000400);
    await waitForPhase(flowId, Phase.awaitingAccountDecision);
    // The admin page rejects first; the Slack approval then meets a revision conflict.
    reviewApi.decideElsewhere(accountId, "rejected");
    thread.reply(reviewerId, "approve");
    assert.equal(await waitForCompletion(flowId), Phase.superseded);
    await waitForThreadReply(flowId, "status: rejected");
    assert.equal(reviewApi.accountOf(accountId)?.status, "rejected");
    assert.equal(gmail.sendMessage().calls().filter((call) => call.flowId === flowId).length, 0);
  });

  test(`${setup.harnessName}: a retried root post keeps one call identity, and an uncertain reply found by its marker is not reposted`, async () => {
    accountCounter += 1;
    const accountId = `acctretry${accountCounter}${Date.now().toString(36)}`;
    const flowId = signupReviewFlowId(accountId);
    // The first attempt fails before Slack answers; the Step's retry posts under the same call identity.
    slack.postChannelMessage().forFlow(flowId).respond(postChannelMessageRetry({ kind: "AVAILABILITY", provider: "slack", operation: "postChannelMessage", message: "try again" }));
    const thread = new ScriptedThread(slack, flowId, "1710000500.000100");
    reviewApi.addPendingAccount({ accountId, email: `retry-${accountCounter}@example.com`, profileUrl: "https://github.com/ada-builds" });
    await watcher.runRound();
    await waitForPhase(flowId, Phase.awaitingAccountDecision);
    const rootPosts = slack.postChannelMessage().calls().filter((call) => call.flowId === flowId);
    assert.equal(rootPosts.length, 2);
    assert.equal(rootPosts[0]!.callId, rootPosts[1]!.callId);
    assert.equal(rootPosts[0]!.idempotencyKey, rootPosts[1]!.idempotencyKey);
    assert.deepEqual(rootPosts.map((call) => call.branch ?? "retry"), ["retry", "sent"]);

    // The next reply's post is uncertain, but the thread shows it arrived: no second post.
    slack
      .postThreadReply()
      .forFlow(flowId)
      .respond(postThreadReplyUncertain({ message: { channelId, timestamp: "", text: "" } }, { kind: "TRANSPORT", provider: "slack", operation: "postThreadReply", message: "lost" }));
    thread.addBotMessage(`Approve the account first [signup-review-${accountId} #1]`);
    thread.reply(reviewerId, "send");
    await pollUntil(() => (slack.postThreadReply().calls().some((call) => call.flowId === flowId) ? true : undefined), {
      description: "the uncertain reply",
      ...waitOptions,
    });
    reviewApi.decideElsewhere(accountId, "active");
    assert.equal(await waitForCompletion(flowId), Phase.superseded);
    const replies = slack.postThreadReply().calls().filter((call) => call.flowId === flowId);
    assert.equal(replies.filter((call) => call.input.text.includes(`#1]`)).length, 1);
  });

  async function assertSessionClosed(flowId: string): Promise<void> {
    const session = await pollUntil(
      async () => {
        const info = await application.client.describeFlow(agentSessionId(flowId));
        return info.status === "running" ? undefined : info;
      },
      { description: "the agent session stops", ...waitOptions },
    );
    assert.notEqual(session.status, "running");
  }
}
