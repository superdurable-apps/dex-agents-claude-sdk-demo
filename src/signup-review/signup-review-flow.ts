// SignupReviewFlow: one Dex Flow per sign-up, from the agent's review to the admins' Slack decision and the email.

import { setTimeout as sleep } from "node:timers/promises";

import type { GmailConnection } from "@superdurable/connector-google-gmail";
import type { Connection as SlackConnection, Message as SlackMessage } from "@superdurable/connector-slack";
import type { Mutation } from "@superdurable/connectors-sdk";
import {
  Attribute,
  doubleCodec,
  ExecuteFailure,
  FlowNotActiveOrNotFoundError,
  gracefulComplete,
  goTo,
  IdReusePolicy,
  IndexType,
  jsonCodec,
  StepList,
  StepRef,
  StopType,
  stringCodec,
  type AsyncContext,
  type Client,
  type Context,
  type Flow,
  type PersistenceSchema,
  type Step,
  type StepDecision,
  type StepOptions,
} from "@superdurable/dex";
import {
  readAgentSnapshot,
  sendAgentUserMessage,
  startAgentSession,
  type AgentMessage,
  type AgentSnapshot,
} from "@superdurable/dex-agents";

import { hasRequestMessage, readTurn, type ReviewSubmission, type SignupAgentSessionFlow } from "../agent/review-submission.js";
import {
  buildInitialReviewMessage,
  buildReminderMessage,
  buildRevisionMessage,
  draftMarker,
  reminderMarker,
} from "../agent/signup-agent-instructions.js";
import {
  AccountStatus,
  decodeAccount,
  ReviewApiError,
  ReviewApiErrorCode,
  type Account,
  type ReviewApiClient,
} from "../review-api/review-api-client.js";
import { connectorStepOptions, runConnectorMutation, runConnectorQuery } from "./connector-calls.js";
import {
  AccountDecisionKind,
  Phase,
  truncate,
  type AgentHarness,
  type DecisionValue,
  type DraftValue,
  type EmailValue,
  type FailureValue,
  type FinalPhase,
  type ReplyContinuation,
  type ReviewValue,
  type RevisionValue,
  type SignupReviewStart,
  type SlackThreadValue,
} from "./signup-review-values.js";
import { buildDraftReply, buildReviewPost, parseReviewCommand, replyMarker, withReplyMarker, type ReviewCommand } from "./slack-review-text.js";

/** Flow type of the review. */
export const signupReviewFlowType = "SignupReviewFlow";

/** FlowID of the review of one account. */
export function signupReviewFlowId(accountId: string): string {
  return `signup-review-${accountId}`;
}

/** Session ID, which is the FlowID, of the review's agent session. */
export function agentSessionId(reviewFlowId: string): string {
  return `${reviewFlowId}-agent`;
}

// ---- Attributes -------------------------------------------------------------------------------------------------

export const accountAttribute = new Attribute<Account>("Account", jsonCodec({ typeName: "Account", decode: decodeAccount }));
export const harnessAttribute = new Attribute<string>("Harness", stringCodec);
export const reviewAttribute = new Attribute<ReviewValue>("Review", jsonCodec({ typeName: "Review" }));
export const draftAttribute = new Attribute<DraftValue>("Draft", jsonCodec({ typeName: "Draft" }));
export const revisionAttribute = new Attribute<RevisionValue>("Revision", jsonCodec({ typeName: "Revision" }));
export const slackThreadAttribute = new Attribute<SlackThreadValue>("SlackThread", jsonCodec({ typeName: "SlackThread" }));
export const cursorAttribute = new Attribute<string>("Cursor", stringCodec);
export const replySeqAttribute = new Attribute<number>("ReplySeq", doubleCodec);
export const decisionAttribute = new Attribute<DecisionValue>("Decision", jsonCodec({ typeName: "Decision" }));
export const emailAttribute = new Attribute<EmailValue>("Email", jsonCodec({ typeName: "Email" }));
export const phaseAttribute = new Attribute<string>("Phase", stringCodec, { type: IndexType.KEYWORD, indexKey: "keyword1" });
export const failureAttribute = new Attribute<FailureValue>("Failure", jsonCodec({ typeName: "Failure" }));

// ---- Dependencies -----------------------------------------------------------------------------------------------

/** Holds the process's Client, which is created after the Registry that holds this Flow. */
export class ClientHolder {
  private client: Client | undefined;

  public set(client: Client): void {
    this.client = client;
  }

  public get(): Client {
    if (this.client === undefined) {
      throw new Error("the Dex Client is not set yet");
    }
    return this.client;
  }
}

/** Waits and limits; tests shorten them. */
export interface SignupReviewTiming {
  readonly agentPollIntervalMs: number;
  readonly agentMaxWaitMs: number;
  readonly threadPollIntervalMs: number;
  readonly threadMaxWaitMs: number;
  /** While the account is undecided, every this many thread rounds also reads the account. */
  readonly accountCheckEveryRounds: number;
}

export const defaultSignupReviewTiming: SignupReviewTiming = {
  agentPollIntervalMs: 5_000,
  agentMaxWaitMs: 15 * 60_000,
  threadPollIntervalMs: 15_000,
  threadMaxWaitMs: 7 * 24 * 60 * 60_000,
  accountCheckEveryRounds: 4,
};

/** What SignupReviewFlow needs from the process. */
export interface SignupReviewDependencies {
  readonly clients: ClientHolder;
  readonly reviewApi: ReviewApiClient;
  readonly slack: SlackConnection;
  readonly gmail: GmailConnection;
  /** The agent session Flow of each harness this Worker runs. */
  readonly agentSessionFlows: ReadonlyMap<AgentHarness, SignupAgentSessionFlow>;
  /** Slack channel ID of the review posts, such as C0123456789. */
  readonly slackChannelId: string;
  /** Slack member IDs whose replies count; everyone else in the thread is ignored. */
  readonly reviewerSlackIds: ReadonlySet<string>;
  readonly timing?: Partial<SignupReviewTiming>;
}

/** Step types, the stable identities of the review's Steps. */
const StepType = {
  loadAccount: "LoadAccount",
  startAgentSession: "StartAgentSession",
  awaitAgentReview: "AwaitAgentReview",
  postReview: "PostReview",
  repostReview: "RepostReview",
  awaitThreadReply: "AwaitThreadReply",
  decideAccount: "DecideAccount",
  requestRevision: "RequestRevision",
  postThreadReply: "PostThreadReply",
  repostReply: "RepostReply",
  sendWelcomeEmail: "SendWelcomeEmail",
  recordFailure: "RecordFailure",
  finish: "Finish",
  stopAgentSession: "StopAgentSession",
} as const;

const to = (stepType: (typeof StepType)[keyof typeof StepType]): StepRef => new StepRef(stepType);

const maxFailureDetailCharacters = 1_000;
const emailPossiblySentNote = "The welcome email may have been sent; check Sent Mail of the team mailbox before sending it by hand.";
const maxThreadPages = 20;
const slackPageSize = 15;
const threadRoundTimeoutMs = 30_000;
const agentRoundTimeoutMs = 10_000;
const reviewApiRetry: StepOptions = {
  executeMethodTimeoutMs: 60_000,
  executeRetry: { initialIntervalMs: 5_000, backoffCoefficient: 2, maximumIntervalMs: 60_000, totalDurationMs: 10 * 60_000 },
};

// ---- Step inputs ------------------------------------------------------------------------------------------------

interface AwaitAgentReviewInput {
  readonly version: number;
}
interface PostReviewInput {
  readonly isRepost: boolean;
}
interface DecideAccountInput {
  readonly decision: AccountDecisionKind;
  readonly reason: string;
  readonly slackUserId: string;
  readonly replyTs: string;
}
interface RequestRevisionInput {
  readonly version: number;
  readonly feedback: string;
  readonly replyTs: string;
}
interface PostThreadReplyInput {
  readonly seq: number;
  readonly text: string;
  readonly then: ReplyContinuation;
}
interface SendWelcomeEmailInput {
  readonly replyTs: string;
}
interface RecordFailureInput {
  readonly detail?: string;
}
interface FinishInput {
  readonly phase: FinalPhase;
}

const awaitReply: ReplyContinuation = { kind: "awaitReply" };
const finishWith = (phase: FinalPhase): ReplyContinuation => ({ kind: "finish", phase });

/** Moves to PostThreadReply with the next reply number; the reply is identified by its marker. */
function replyInThread(context: Context, text: string, then: ReplyContinuation): StepDecision {
  const seq = (replySeqAttribute.get(context) || 0) + 1;
  replySeqAttribute.set(context, seq);
  return goTo<PostThreadReplyInput>(to(StepType.postThreadReply), { seq, text, then });
}

function continueAfterReply(then: ReplyContinuation): StepDecision {
  return then.kind === "awaitReply" ? goTo(to(StepType.awaitThreadReply), {}) : goTo<FinishInput>(to(StepType.finish), { phase: then.phase });
}

function failWith(detail: string): StepDecision {
  return goTo<RecordFailureInput>(to(StepType.recordFailure), { detail });
}

function describeError(error: unknown): string {
  return truncate(error instanceof Error ? `${error.name}: ${error.message}` : String(error), maxFailureDetailCharacters);
}

function roundSignal(context: AsyncContext, timeoutMs: number): AbortSignal {
  return AbortSignal.any([context.cancellationSignal, AbortSignal.timeout(timeoutMs)]);
}

// ---- Steps ------------------------------------------------------------------------------------------------------

// dex:group group-id:start group-label:"Start"
// dex:explanation text:"Reads the account from the review API and ends the review when it is no longer pending."
class LoadAccount implements Step<SignupReviewStart> {
  public constructor(private readonly dependencies: SignupReviewDependencies) {}

  public getStepType(): string {
    return StepType.loadAccount;
  }

  public getStepOptions(): StepOptions {
    return { ...reviewApiRetry, executeFailure: ExecuteFailure.proceedTo(to(StepType.recordFailure)) };
  }

  public async execute(context: AsyncContext, start: SignupReviewStart): Promise<StepDecision> {
    harnessAttribute.set(context, start.harness);
    phaseAttribute.set(context, Phase.analyzing);
    const account = await this.dependencies.reviewApi.getAccount(start.accountId, context.cancellationSignal);
    accountAttribute.set(context, account);
    if (account.status !== AccountStatus.pendingApproval) {
      return goTo<FinishInput>(to(StepType.finish), { phase: Phase.superseded });
    }
    return goTo(to(StepType.startAgentSession), {});
  }
}

// dex:group group-id:agent group-label:"Agent review"
// dex:explanation text:"Starts the agent session with the applicant's sign-up data as its first message."
class StartAgentSession implements Step<object> {
  public constructor(private readonly dependencies: SignupReviewDependencies) {}

  public getStepType(): string {
    return StepType.startAgentSession;
  }

  public getStepOptions(): StepOptions {
    return { ...reviewApiRetry, executeFailure: ExecuteFailure.proceedTo(to(StepType.recordFailure)) };
  }

  public async execute(context: AsyncContext): Promise<StepDecision> {
    const sessionFlow = agentSessionFlowOf(this.dependencies, context);
    const sessionId = agentSessionId(context.flowId);
    // A retry with the same Request ID joins the session the first attempt started.
    await startAgentSession(
      this.dependencies.clients.get(),
      sessionFlow,
      sessionId,
      { initialMessage: buildInitialReviewMessage(accountAttribute.get(context)) },
      { requestId: sessionId, ignoreAlreadyStarted: true, idReusePolicy: IdReusePolicy.DISALLOW },
    );
    return goTo<AwaitAgentReviewInput>(to(StepType.awaitAgentReview), { version: 1 });
  }
}

function agentSessionFlowOf(dependencies: SignupReviewDependencies, context: Context): SignupAgentSessionFlow {
  const harness = harnessAttribute.get(context) as AgentHarness;
  const flow = dependencies.agentSessionFlows.get(harness);
  if (flow === undefined) {
    throw new Error(`this Worker does not run the ${harness} harness; start it with SIGNUP_AGENT_HARNESS=${harness}`);
  }
  return flow;
}

/** The session's messages back to the user message that starts with `marker`, paging older messages when needed. */
async function messagesSince(client: Client, flow: SignupAgentSessionFlow, sessionId: string, snapshot: AgentSnapshot, marker: string): Promise<AgentSnapshot> {
  let messages: readonly AgentMessage[] = snapshot.messages;
  const contains = (list: readonly AgentMessage[]): boolean => list.some((message) => message.role === "user" && (message.text ?? "").startsWith(marker));
  for (let page = 0; page < 20 && !contains(messages) && (messages[0]?.sequence ?? 1) > 1; page++) {
    const older = await client.invokeRPC(flow.listAgentMessages, sessionId, { beforeSequence: messages[0]?.sequence ?? null, limit: 200 });
    if (older.messages.length === 0) {
      break;
    }
    messages = [...older.messages, ...messages];
  }
  return messages === snapshot.messages ? snapshot : { ...snapshot, messages };
}

// dex:group group-id:agent group-label:"Agent review"
// dex:explanation text:"Polls the agent session until the requested draft's turn ends and reads its submit_review call."
class AwaitAgentReview implements Step<AwaitAgentReviewInput> {
  private readonly timing: SignupReviewTiming;

  public constructor(private readonly dependencies: SignupReviewDependencies) {
    this.timing = { ...defaultSignupReviewTiming, ...dependencies.timing };
  }

  public getStepType(): string {
    return StepType.awaitAgentReview;
  }

  public getStepOptions(): StepOptions {
    return {
      executeMethodTimeoutMs: this.timing.agentMaxWaitMs,
      heartbeatTimeoutMs: 60_000,
      executeRetry: { maximumAttempts: 5, totalDurationMs: this.timing.agentMaxWaitMs },
      executeFailure: ExecuteFailure.proceedTo(to(StepType.recordFailure)),
    };
  }

  public async execute(context: AsyncContext, input: AwaitAgentReviewInput): Promise<StepDecision> {
    const client = this.dependencies.clients.get();
    const sessionFlow = agentSessionFlowOf(this.dependencies, context);
    const sessionId = agentSessionId(context.flowId);
    const requestMarker = draftMarker(input.version);
    const reminder = reminderMarker(input.version);
    let submission: ReviewSubmission | undefined;
    for (let round = 1; submission === undefined; round++) {
      const current = await readAgentSnapshot(client, sessionFlow, sessionId);
      // A reminder sent by an earlier attempt is the request whose turn decides.
      const marker = hasRequestMessage(current, reminder) ? reminder : requestMarker;
      const snapshot = await messagesSince(client, sessionFlow, sessionId, current, marker);
      const reading = readTurn(snapshot, marker);
      if (reading.kind === "sessionFailed") {
        throw new Error(`the agent session failed: ${truncate(reading.reason, 500)}`);
      }
      if (reading.kind === "submitted") {
        submission = reading.submission;
        break;
      }
      if (reading.kind === "noSubmission") {
        if (marker === reminder) {
          const lastError = reading.lastTurnError === null ? "" : `: ${truncate(reading.lastTurnError, 500)}`;
          throw new Error(`the agent ended two turns without a valid submit_review call${lastError}`);
        }
        await sendAgentUserMessage(client, sessionFlow, sessionId, { text: buildReminderMessage(input.version) });
      }
      await context.recordHeartbeat(round);
      await sleep(this.timing.agentPollIntervalMs, undefined, { signal: context.cancellationSignal });
    }
    const draft: DraftValue = { subject: submission.emailSubject, body: submission.emailBody, version: input.version };
    draftAttribute.set(context, draft);
    if (input.version === 1) {
      reviewAttribute.set(context, { recommendation: submission.recommendation, reasons: submission.reasons });
      return goTo<PostReviewInput>(to(StepType.postReview), { isRepost: false });
    }
    const isApproved = decisionAttribute.get(context)?.decision === AccountDecisionKind.approved;
    return replyInThread(context, buildDraftReply(draft, isApproved), awaitReply);
  }
}

// dex:group group-id:slack group-label:"Slack"
// dex:explanation text:"Posts the review to the Slack channel; an uncertain post is repeated once by RepostReview."
class PostReview implements Step<PostReviewInput> {
  public constructor(
    private readonly dependencies: SignupReviewDependencies,
    private readonly stepType: typeof StepType.postReview | typeof StepType.repostReview,
  ) {}

  public getStepType(): string {
    return this.stepType;
  }

  public getStepOptions(): StepOptions {
    return connectorStepOptions(this.dependencies.slack.operations.postChannelMessage().definition().stepDefaults, {
      executeFailure: ExecuteFailure.proceedTo(to(StepType.recordFailure)),
    });
  }

  public async execute(context: AsyncContext, input: PostReviewInput): Promise<StepDecision> {
    const text = buildReviewPost({
      flowId: context.flowId,
      account: accountAttribute.get(context),
      review: reviewAttribute.get(context),
      draft: draftAttribute.get(context),
      harness: harnessAttribute.get(context) as AgentHarness,
      isRepost: input.isRepost,
    });
    const operation = this.dependencies.slack.operations.postChannelMessage();
    const result = await runConnectorMutation(context, this.dependencies.slack.reference, operation, {
      channelId: this.dependencies.slackChannelId,
      text,
    });
    if (result.branch === "sent") {
      slackThreadAttribute.set(context, { channel: result.value.message.channelId, ts: result.value.message.timestamp });
      cursorAttribute.set(context, result.value.message.timestamp);
      phaseAttribute.set(context, Phase.awaitingAccountDecision);
      return goTo(to(StepType.awaitThreadReply), {});
    }
    if (result.branch === "uncertain" && this.stepType === StepType.postReview) {
      return recoverUncertainReviewPost();
    }
    return failWith(`posting the review to Slack ended ${result.branch}: ${result.failure?.message ?? "no detail"}`);
  }
}

/**
 * An uncertain root post has no timestamp, so there is no thread to look in, and Slack connector 0.4 reads no channel
 * history: the review is posted once more as a new call, accepting at most one duplicate post. Once the connector can
 * list channel messages, this is the place to search the channel for the review's footer before posting again.
 */
function recoverUncertainReviewPost(): StepDecision {
  return goTo<PostReviewInput>(to(StepType.repostReview), { isRepost: true });
}

/** A thread message an allowed reviewer wrote after the cursor. */
interface ReviewerReply {
  readonly ts: string;
  readonly userId: string;
  readonly command: ReviewCommand;
}

/** Whether Slack timestamp `ts` (`<seconds>.<microseconds>`) is later than `cursor`, compared exactly. */
function isAfter(ts: string, cursor: string): boolean {
  const exact = (value: string): bigint => {
    const [seconds = "0", fraction = ""] = value.split(".");
    return BigInt(seconds) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6) || "0");
  };
  return exact(ts) > exact(cursor);
}

// dex:group group-id:slack group-label:"Slack"
// dex:explanation text:"Polls the Slack thread for the next reviewer command and checks whether the account was decided elsewhere."
class AwaitThreadReply implements Step<object> {
  private readonly timing: SignupReviewTiming;

  public constructor(private readonly dependencies: SignupReviewDependencies) {
    this.timing = { ...defaultSignupReviewTiming, ...dependencies.timing };
  }

  public getStepType(): string {
    return StepType.awaitThreadReply;
  }

  public getStepOptions(): StepOptions {
    // The loop ends the wait itself at threadMaxWaitMs; the method timeout is only a backstop.
    const backstopMs = this.timing.threadMaxWaitMs + 60 * 60_000;
    return {
      executeMethodTimeoutMs: backstopMs,
      heartbeatTimeoutMs: 60_000,
      executeRetry: { maximumAttempts: 20, totalDurationMs: backstopMs },
      executeFailure: ExecuteFailure.proceedTo(to(StepType.recordFailure)),
    };
  }

  public async execute(context: AsyncContext): Promise<StepDecision> {
    const thread = slackThreadAttribute.get(context);
    const phase = phaseAttribute.get(context);
    const startedAt = context.firstAttemptAt.getTime();
    for (let round = 1; ; round++) {
      if (Date.now() - startedAt >= this.timing.threadMaxWaitMs) {
        return replyInThread(
          context,
          "No decision arrived in this thread in time, so the review is closed. Decide on the account in Dex Cloud admin.",
          finishWith(Phase.timedOut),
        );
      }
      const reply = await this.readNextReply(context, thread, cursorAttribute.get(context) ?? thread.ts);
      if (reply !== undefined) {
        return this.decide(context, phase, reply);
      }
      if (phase === Phase.awaitingAccountDecision && round % this.timing.accountCheckEveryRounds === 0) {
        const account = await this.dependencies.reviewApi.getAccount(accountAttribute.get(context).accountId, roundSignal(context, 20_000));
        if (account.status !== AccountStatus.pendingApproval) {
          accountAttribute.set(context, account);
          return replyInThread(context, decidedElsewhereText(account), finishWith(Phase.superseded));
        }
      }
      await context.recordHeartbeat(round);
      await sleep(this.timing.threadPollIntervalMs, undefined, { signal: context.cancellationSignal });
    }
  }

  private async readNextReply(context: AsyncContext, thread: SlackThreadValue, cursor: string): Promise<ReviewerReply | undefined> {
    const operation = this.dependencies.slack.operations.listThreadMessages();
    const deadline = Date.now() + threadRoundTimeoutMs;
    let pageCursor: string | undefined;
    for (let page = 0; page < maxThreadPages && Date.now() < deadline; page++) {
      const result = await runConnectorQuery(context, this.dependencies.slack.reference, operation, {
        channelId: thread.channel,
        threadTimestamp: thread.ts,
        pageSize: slackPageSize,
        ...(pageCursor === undefined ? {} : { cursor: pageCursor }),
      });
      if (result.branch !== "read") {
        throw new Error(`reading the Slack thread ended ${result.branch}: ${result.failure?.message ?? "no detail"}`);
      }
      const next = (result.value.messages ?? []).find((message) => this.isReviewerReply(message, thread, cursor));
      if (next !== undefined) {
        const command = parseReviewCommand(next.text);
        if (command !== undefined) {
          return { ts: next.timestamp, userId: next.userId ?? "", command };
        }
      }
      pageCursor = result.value.nextCursor;
      if (!pageCursor) {
        return undefined;
      }
    }
    return undefined;
  }

  private isReviewerReply(message: SlackMessage, thread: SlackThreadValue, cursor: string): boolean {
    return (
      message.timestamp !== thread.ts &&
      isAfter(message.timestamp, cursor) &&
      message.userId !== undefined &&
      this.dependencies.reviewerSlackIds.has(message.userId) &&
      message.text.trim() !== ""
    );
  }

  private decide(context: AsyncContext, phase: string, reply: ReviewerReply): StepDecision {
    const command = reply.command;
    if (phase === Phase.awaitingAccountDecision) {
      if (command.kind === "approve" || command.kind === "reject") {
        return goTo<DecideAccountInput>(to(StepType.decideAccount), {
          decision: command.kind === "approve" ? AccountDecisionKind.approved : AccountDecisionKind.rejected,
          reason: command.kind === "reject" ? truncate(command.reason, 500) : "",
          slackUserId: reply.userId,
          replyTs: reply.ts,
        });
      }
      if (command.kind === "send") {
        cursorAttribute.set(context, reply.ts);
        return replyInThread(context, "Approve the account first: reply `approve`, or `reject <reason>`.", awaitReply);
      }
    } else {
      if (command.kind === "send") {
        // Committed before the send, so a failure route knows the email may have gone out.
        phaseAttribute.set(context, Phase.sending);
        return goTo<SendWelcomeEmailInput>(to(StepType.sendWelcomeEmail), { replyTs: reply.ts });
      }
      if (command.kind === "approve" || command.kind === "reject") {
        cursorAttribute.set(context, reply.ts);
        return replyInThread(context, "The account is already approved. Reply `send` to send the email, or write what to change.", awaitReply);
      }
    }
    const version = (draftAttribute.get(context)?.version ?? 1) + 1;
    return goTo<RequestRevisionInput>(to(StepType.requestRevision), {
      version,
      feedback: truncate(command.kind === "feedback" ? command.text : "", 4_000),
      replyTs: reply.ts,
    });
  }
}

function decidedElsewhereText(account: Account): string {
  return `This account was already decided in Dex Cloud admin (status: ${account.status}), so this review ends here and no email is sent.`;
}

// dex:group group-id:decision group-label:"Account decision"
// dex:explanation text:"Approves or rejects the account through the review API with the expected revision."
class DecideAccount implements Step<DecideAccountInput> {
  public constructor(private readonly dependencies: SignupReviewDependencies) {}

  public getStepType(): string {
    return StepType.decideAccount;
  }

  public getStepOptions(): StepOptions {
    return { ...reviewApiRetry, executeFailure: ExecuteFailure.proceedTo(to(StepType.recordFailure)) };
  }

  public async execute(context: AsyncContext, input: DecideAccountInput): Promise<StepDecision> {
    const account = accountAttribute.get(context);
    const api = this.dependencies.reviewApi;
    const requestId = `${context.flowId}-${input.decision === AccountDecisionKind.approved ? "approve" : "reject"}-r${account.revision}`;
    let decided: Account;
    try {
      decided =
        input.decision === AccountDecisionKind.approved
          ? await api.approveAccount(
              { accountId: account.accountId, requestId, expectedRevision: account.revision, suppressApprovedMail: true },
              context.cancellationSignal,
            )
          : await api.rejectAccount({ accountId: account.accountId, requestId, expectedRevision: account.revision }, context.cancellationSignal);
    } catch (error: unknown) {
      if (!(error instanceof ReviewApiError) || !isDecisionConflict(error)) {
        throw error;
      }
      const current = error.currentAccount ?? (await api.getAccount(account.accountId, context.cancellationSignal));
      accountAttribute.set(context, current);
      cursorAttribute.set(context, input.replyTs);
      if (current.status !== AccountStatus.pendingApproval) {
        return replyInThread(context, decidedElsewhereText(current), finishWith(Phase.superseded));
      }
      return replyInThread(context, "The account changed after this review was posted. Please decide again: reply `approve` or `reject <reason>`.", awaitReply);
    }
    accountAttribute.set(context, decided);
    cursorAttribute.set(context, input.replyTs);
    decisionAttribute.set(context, { decision: input.decision, slackUserId: input.slackUserId, at: new Date().toISOString(), reason: input.reason });
    if (input.decision === AccountDecisionKind.rejected) {
      return replyInThread(context, `Rejected by <@${input.slackUserId}>: ${input.reason}. No email is sent.`, finishWith(Phase.rejected));
    }
    phaseAttribute.set(context, Phase.reviewingEmail);
    return replyInThread(
      context,
      `Approved by <@${input.slackUserId}>. The account is active. Reply \`send\` to send the welcome email above, or write what to change.`,
      awaitReply,
    );
  }
}

function isDecisionConflict(error: ReviewApiError): boolean {
  return (
    error.code === ReviewApiErrorCode.revisionConflict ||
    error.code === ReviewApiErrorCode.failedPrecondition ||
    error.code === ReviewApiErrorCode.notFound
  );
}

// dex:group group-id:agent group-label:"Agent review"
// dex:explanation text:"Sends the reviewers' feedback to the agent session once, as the request for the next draft."
class RequestRevision implements Step<RequestRevisionInput> {
  public constructor(private readonly dependencies: SignupReviewDependencies) {}

  public getStepType(): string {
    return StepType.requestRevision;
  }

  public getStepOptions(): StepOptions {
    return { ...reviewApiRetry, executeFailure: ExecuteFailure.proceedTo(to(StepType.recordFailure)) };
  }

  public async execute(context: AsyncContext, input: RequestRevisionInput): Promise<StepDecision> {
    const client = this.dependencies.clients.get();
    const sessionFlow = agentSessionFlowOf(this.dependencies, context);
    const sessionId = agentSessionId(context.flowId);
    // send_user_message has no idempotency key: a retried attempt first looks for its own marker.
    const snapshot = await readAgentSnapshot(client, sessionFlow, sessionId);
    if (!hasRequestMessage(snapshot, draftMarker(input.version))) {
      await sendAgentUserMessage(client, sessionFlow, sessionId, { text: buildRevisionMessage(input.version, input.feedback) });
    }
    revisionAttribute.set(context, { requested: input.version, feedback: input.feedback });
    cursorAttribute.set(context, input.replyTs);
    return goTo<AwaitAgentReviewInput>(to(StepType.awaitAgentReview), { version: input.version });
  }
}

// dex:group group-id:slack group-label:"Slack"
// dex:explanation text:"Posts one marked reply in the review thread; an uncertain post is looked up by its marker before RepostReply."
class PostThreadReply implements Step<PostThreadReplyInput> {
  public constructor(
    private readonly dependencies: SignupReviewDependencies,
    private readonly stepType: typeof StepType.postThreadReply | typeof StepType.repostReply,
  ) {}

  public getStepType(): string {
    return this.stepType;
  }

  public getStepOptions(): StepOptions {
    return connectorStepOptions(this.dependencies.slack.operations.postThreadReply().definition().stepDefaults, {
      executeFailure: ExecuteFailure.proceedTo(to(StepType.recordFailure)),
    });
  }

  public async execute(context: AsyncContext, input: PostThreadReplyInput): Promise<StepDecision> {
    const thread = slackThreadAttribute.get(context);
    if (thread === undefined) {
      return continueAfterReply(input.then);
    }
    const marker = replyMarker(accountAttribute.get(context).accountId, input.seq);
    const result = await runConnectorMutation(context, this.dependencies.slack.reference, this.dependencies.slack.operations.postThreadReply(), {
      channelId: thread.channel,
      threadTimestamp: thread.ts,
      text: withReplyMarker(input.text, marker),
    });
    if (result.branch === "sent") {
      return continueAfterReply(input.then);
    }
    if (result.branch === "uncertain") {
      if (await this.isMarkerInThread(context, thread, marker)) {
        return continueAfterReply(input.then);
      }
      if (this.stepType === StepType.postThreadReply) {
        return goTo<PostThreadReplyInput>(to(StepType.repostReply), input);
      }
    }
    return failWith(`replying in the Slack thread ended ${result.branch}: ${result.failure?.message ?? "no detail"}`);
  }

  private async isMarkerInThread(context: AsyncContext, thread: SlackThreadValue, marker: string): Promise<boolean> {
    const operation = this.dependencies.slack.operations.listThreadMessages();
    let cursor: string | undefined;
    for (let page = 0; page < maxThreadPages; page++) {
      const result = await runConnectorQuery(context, this.dependencies.slack.reference, operation, {
        channelId: thread.channel,
        threadTimestamp: thread.ts,
        pageSize: slackPageSize,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (result.branch !== "read") {
        throw new Error(`reading the Slack thread ended ${result.branch}`);
      }
      if ((result.value.messages ?? []).some((message) => message.text.includes(marker))) {
        return true;
      }
      cursor = result.value.nextCursor;
      if (!cursor) {
        return false;
      }
    }
    return false;
  }
}

// dex:group group-id:email group-label:"Welcome email"
// dex:explanation text:"Sends the current draft from the team mailbox; the Gmail connector never sends one call twice."
class SendWelcomeEmail implements Step<SendWelcomeEmailInput> {
  public constructor(private readonly dependencies: SignupReviewDependencies) {}

  public getStepType(): string {
    return StepType.sendWelcomeEmail;
  }

  public getStepOptions(): StepOptions {
    return connectorStepOptions(this.sendOperation().definition().stepDefaults, {
      executeFailure: ExecuteFailure.proceedTo(to(StepType.recordFailure)),
    });
  }

  public async execute(context: AsyncContext, input: SendWelcomeEmailInput): Promise<StepDecision> {
    const account = accountAttribute.get(context);
    const draft = draftAttribute.get(context);
    const result = await runConnectorMutation(context, this.dependencies.gmail.reference, this.sendOperation(), {
      to: [account.email],
      subject: draft.subject,
      textBody: draft.body,
    });
    if (result.branch === "providerRejected") {
      return failWith(`Gmail rejected the welcome email: ${result.failure?.message ?? "no detail"}`);
    }
    if (result.branch !== "sent") {
      return failWith(`${emailPossiblySentNote} The send ended ${result.branch}: ${result.failure?.message ?? "no detail"}`);
    }
    cursorAttribute.set(context, input.replyTs);
    emailAttribute.set(context, { gmailMessageId: result.value.messageId, draftVersion: draft.version, sentAt: new Date().toISOString() });
    return replyInThread(context, `Sent the welcome email (draft v${draft.version}) to ${account.email}.`, finishWith(Phase.done));
  }

  private sendOperation(): Mutation<{ to: string[]; subject: string; textBody: string }, { messageId: string }> {
    // The Gmail package builds on its own copy of the Connector SDK; its operations have the same shape.
    return this.dependencies.gmail.operations.sendMessage() as unknown as Mutation<
      { to: string[]; subject: string; textBody: string },
      { messageId: string }
    >;
  }
}

// dex:group group-id:finish group-label:"Finish"
// dex:explanation text:"Records why the review failed and says so in the thread when there is one."
class RecordFailure implements Step<RecordFailureInput> {
  public getStepType(): string {
    return StepType.recordFailure;
  }

  public execute(context: Context, input: RecordFailureInput): StepDecision {
    if (failureAttribute.get(context) !== undefined) {
      // A failure while reporting a failure: finish without another reply.
      return goTo<FinishInput>(to(StepType.finish), { phase: Phase.failed });
    }
    const cause = input.detail ?? context.recoveryError?.detail ?? "unknown failure";
    // A send Step that ran out of attempts may have dispatched: Gmail is never asked again, a person checks.
    const isSendUnconfirmed = input.detail === undefined && phaseAttribute.get(context) === Phase.sending;
    const detail = truncate(isSendUnconfirmed ? `${emailPossiblySentNote} ${cause}` : cause, maxFailureDetailCharacters);
    failureAttribute.set(context, { step: context.fromStepExecutionId, detail });
    if (slackThreadAttribute.get(context) === undefined) {
      return goTo<FinishInput>(to(StepType.finish), { phase: Phase.failed });
    }
    return replyInThread(
      context,
      `The review stopped because of an error: ${truncate(detail, 300)}. Decide on the account in Dex Cloud admin.`,
      finishWith(Phase.failed),
    );
  }
}

// dex:group group-id:finish group-label:"Finish"
// dex:explanation text:"Writes the final phase."
class Finish implements Step<FinishInput> {
  public getStepType(): string {
    return StepType.finish;
  }

  public execute(context: Context, input: FinishInput): StepDecision {
    phaseAttribute.set(context, input.phase);
    return goTo<FinishInput>(to(StepType.stopAgentSession), input);
  }
}

// dex:group group-id:finish group-label:"Finish"
// dex:explanation text:"Stops the agent session and completes the review."
class StopAgentSession implements Step<FinishInput> {
  public constructor(private readonly dependencies: SignupReviewDependencies) {}

  public getStepType(): string {
    return StepType.stopAgentSession;
  }

  public getStepOptions(): StepOptions {
    return reviewApiRetry;
  }

  public async execute(context: AsyncContext, input: FinishInput): Promise<StepDecision> {
    try {
      await this.dependencies.clients
        .get()
        .stopFlow(agentSessionId(context.flowId), { type: StopType.CANCEL, reason: `the review ended ${input.phase}` });
    } catch (error: unknown) {
      if (!(error instanceof FlowNotActiveOrNotFoundError)) {
        throw error;
      }
    }
    return gracefulComplete(input.phase);
  }
}

// ---- Flow -------------------------------------------------------------------------------------------------------

/** One review of one Dex Cloud sign-up. The FlowID is {@link signupReviewFlowId}. */
export class SignupReviewFlow implements Flow<SignupReviewStart> {
  private readonly loadAccount: LoadAccount;
  private readonly startAgentSession: StartAgentSession;
  private readonly awaitAgentReview: AwaitAgentReview;
  private readonly postReview: PostReview;
  private readonly repostReview: PostReview;
  private readonly awaitThreadReply: AwaitThreadReply;
  private readonly decideAccount: DecideAccount;
  private readonly requestRevision: RequestRevision;
  private readonly postThreadReply: PostThreadReply;
  private readonly repostReply: PostThreadReply;
  private readonly sendWelcomeEmail: SendWelcomeEmail;
  private readonly recordFailure = new RecordFailure();
  private readonly finish = new Finish();
  private readonly stopAgentSession: StopAgentSession;

  public constructor(dependencies: SignupReviewDependencies) {
    this.loadAccount = new LoadAccount(dependencies);
    this.startAgentSession = new StartAgentSession(dependencies);
    this.awaitAgentReview = new AwaitAgentReview(dependencies);
    this.postReview = new PostReview(dependencies, StepType.postReview);
    this.repostReview = new PostReview(dependencies, StepType.repostReview);
    this.awaitThreadReply = new AwaitThreadReply(dependencies);
    this.decideAccount = new DecideAccount(dependencies);
    this.requestRevision = new RequestRevision(dependencies);
    this.postThreadReply = new PostThreadReply(dependencies, StepType.postThreadReply);
    this.repostReply = new PostThreadReply(dependencies, StepType.repostReply);
    this.sendWelcomeEmail = new SendWelcomeEmail(dependencies);
    this.stopAgentSession = new StopAgentSession(dependencies);
  }

  public getFlowType(): string {
    return signupReviewFlowType;
  }

  public getSteps(): StepList<SignupReviewStart> {
    return StepList.startStep(this.loadAccount).otherSteps(
      this.startAgentSession,
      this.awaitAgentReview,
      this.postReview,
      this.repostReview,
      this.awaitThreadReply,
      this.decideAccount,
      this.requestRevision,
      this.postThreadReply,
      this.repostReply,
      this.sendWelcomeEmail,
      this.recordFailure,
      this.finish,
      this.stopAgentSession,
    );
  }

  public getPersistenceSchema(): PersistenceSchema {
    return {
      attributes: [
        accountAttribute,
        harnessAttribute,
        reviewAttribute,
        draftAttribute,
        revisionAttribute,
        slackThreadAttribute,
        cursorAttribute,
        replySeqAttribute,
        decisionAttribute,
        emailAttribute,
        phaseAttribute,
        failureAttribute,
      ],
    };
  }
}
