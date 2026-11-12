// The signup review agent, shared by every harness: its prompt and its tools.
// Each write tool checks its own guard first, from the session's Dex state, Slack and the ReviewAPI, so the
// model can ask for anything but only a reviewer's reply in Slack lets a decision or an email through.

import type { Mutation } from "@superdurable/connectors-sdk";
import gmailManifest from "@superdurable/connector-google-gmail/dex-connector.json" with { type: "json" };
import type { GmailConnection } from "@superdurable/connector-google-gmail";
import slackManifest from "@superdurable/connector-slack/dex-connector.json" with { type: "json" };
import type { Connection as SlackConnection } from "@superdurable/connector-slack";
import { ToolExecutionError, type ToolEffect, type ToolSource } from "@superdurable/dex-agents";
import { ConnectorToolSource, connectorTool, type ConnectorPackageManifest } from "@superdurable/dex-agents/connectors";
import { z } from "zod";

import type { ProfileSources } from "./profile-sources.js";
import { accountIdOf, readReviewerReplies, readReviewState, isLater, reviewSessionId, type ReviewState } from "./review-state.js";
import { ReviewApiError, type Account, type ReviewApiClient } from "./review-api.js";

export const signupAgentPrompt = `You review sign-ups for Dex Cloud, a hosted platform for building durable applications and AI agents, together with the admins in Slack.

Procedure:
1. Research. Call get_account for the account in the first message. Look the applicant up: github_user for a GitHub login (from a github.com link or the email), fetch_profile for a profile link or personal website. Pages on x.com and twitter.com usually cannot be read; then say that the information is insufficient.
2. Decide on a recommendation: approve when the evidence points to a real person who builds software; reject for clear spam, throwaway or bot-like sign-ups. Never invent facts: every reason is something a tool returned, or the absence of information.
3. Call post_review once, with the recommendation, one to six short reasons, and a welcome email draft. Write the email to the applicant in plain text: warm, two or three short paragraphs, personalized only with real facts you found, inviting them to start building on Dex Cloud, signed "The Dex Cloud team". Never put your review or doubts in the email. Then end your turn and wait.
4. Admins' replies arrive as messages "[slack <ts>] <text>". Act on each:
   - "approve": call approve_account. "reject <reason>": call reject_account with the reason.
   - "send", after the account is approved: call send_welcome_email. It sends the latest posted draft.
   - Anything else is feedback on the email: write a new draft and call post_draft.
   - Messages "[dex-cloud ...]" tell you the account was decided in Dex Cloud admin: say so with reply_in_thread and finish.
   A tool that refuses tells you why; explain it briefly with reply_in_thread when it helps the admins. Be concise.
5. When the email was sent, the account was rejected, or the account was decided elsewhere, post a one-line summary with reply_in_thread and call finish_review.`;

/** What the tools reach. Credentials stay in these objects, never in Flow state. */
export interface SignupServices {
  readonly reviewApi: ReviewApiClient;
  readonly profiles: ProfileSources;
  readonly slack: SlackConnection;
  readonly gmail: GmailConnection;
  readonly slackChannelId: string;
  readonly reviewerSlackIds: ReadonlySet<string>;
  /** Shown in the review post, such as "pi (Dex built-in agent loop)". */
  readonly harnessLabel: string;
}

/** A tool both harnesses wrap: its name, description, arguments, effect, and what it does. */
export interface SignupTool {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodObject;
  readonly effect: ToolEffect;
  /** `sessionId` is the session's own FlowID; read tools run without it in the Claude Code CLI. */
  run(args: Record<string, unknown>, sessionId: string | undefined, signal: AbortSignal): Promise<unknown>;
}

const refuse = (reason: string): never => {
  throw new ToolExecutionError(`refused: ${reason}`);
};

const accountIdArgument = z.object({ accountId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).describe("The account ID from the first message.") });

/** The tools that do not post to Slack or Gmail. */
export function createSignupTools(services: SignupServices): SignupTool[] {
  const requireSession = (sessionId: string | undefined): string => sessionId ?? refuse("this tool runs only in a tool Step of the review session");

  /** Fails unless a reviewer replied in the thread with a message that `matches`. */
  async function requireReviewerReply(sessionId: string, state: ReviewState, matches: (text: string) => boolean, what: string, signal: AbortSignal) {
    const thread = state.thread ?? refuse("call post_review first");
    const replies = await readReviewerReplies(services.slack, sessionId, thread, services.reviewerSlackIds, signal);
    return replies.find((reply) => matches(reply.text.trim().toLowerCase())) ?? refuse(`no reviewer has replied ${what} in the Slack thread`);
  }

  /** Approves or rejects with the expected revision; an account decided elsewhere is `superseded`, not an error. */
  async function decide(sessionId: string, decision: "approve" | "reject", signal: AbortSignal) {
    const account = await services.reviewApi.getAccount(accountIdOf(sessionId), signal);
    if (account.status !== "pending_approval") {
      return { status: "superseded", accountStatus: account.status };
    }
    const request = { accountId: account.accountId, requestId: `${sessionId}-${decision}-r${account.revision}`, expectedRevision: account.revision };
    try {
      const decided =
        decision === "approve"
          ? await services.reviewApi.approveAccount({ ...request, suppressApprovedMail: true }, signal)
          : await services.reviewApi.rejectAccount(request, signal);
      return { status: decision === "approve" ? "approved" : "rejected", accountStatus: decided.status };
    } catch (error: unknown) {
      if (error instanceof ReviewApiError && error.code === "revision_conflict") {
        return { status: "superseded", accountStatus: error.currentAccount?.status ?? "unknown" };
      }
      throw error;
    }
  }

  return [
    {
      name: "get_account",
      description: "Read a Dex Cloud account: email, name, profile link, sign-up method, status.",
      schema: accountIdArgument,
      effect: "read",
      run: async (args, _sessionId, signal) => services.reviewApi.getAccount(String(args.accountId), signal),
    },
    {
      name: "fetch_profile",
      description: "Fetch a public HTTPS page, such as a personal website, and return its title and visible text (at most 1 MB).",
      schema: z.object({ url: z.string().describe("The https URL.") }),
      effect: "read",
      run: async (args, _sessionId, signal) => services.profiles.fetchProfilePage(String(args.url), signal),
    },
    {
      name: "github_user",
      description: "Look up a GitHub user: name, bio, company, followers, account age, and their most starred repositories.",
      schema: z.object({ login: z.string().describe("The GitHub login, without @.") }),
      effect: "read",
      run: async (args, _sessionId, signal) => services.profiles.fetchGitHubUser(String(args.login).replace(/^@/, ""), signal),
    },
    {
      name: "read_review_thread",
      description: "Read the reviewers' replies in the review's Slack thread, oldest first.",
      schema: accountIdArgument,
      effect: "read",
      run: async (args, _sessionId, signal) => {
        const sessionId = reviewSessionId(String(args.accountId));
        const thread = (await readReviewState(sessionId)).thread ?? refuse("the review is not posted yet");
        const replies = await readReviewerReplies(services.slack, sessionId, thread, services.reviewerSlackIds, signal);
        return replies.map((reply) => ({ ts: reply.timestamp, user: reply.userId, text: reply.text }));
      },
    },
    {
      name: "approve_account",
      description: "Approve the account in Dex Cloud. Allowed only after a reviewer replied `approve` in the thread.",
      schema: z.object({}),
      effect: "idempotent_write",
      run: async (_args, sessionId, signal) => {
        const session = requireSession(sessionId);
        await requireReviewerReply(session, await readReviewState(session), (text) => /^approve[.!]?$/.test(text), "`approve`", signal);
        return decide(session, "approve", signal);
      },
    },
    {
      name: "reject_account",
      description: "Reject the account in Dex Cloud. Allowed only after a reviewer replied `reject <reason>` in the thread.",
      schema: z.object({ reason: z.string().describe("The reviewer's reason.") }),
      effect: "idempotent_write",
      run: async (args, sessionId, signal) => {
        const session = requireSession(sessionId);
        await requireReviewerReply(session, await readReviewState(session), (text) => /^reject\b/.test(text), "`reject <reason>`", signal);
        return { ...(await decide(session, "reject", signal)), reason: String(args.reason) };
      },
    },
    {
      name: "finish_review",
      description: "End the review. Allowed once the email was sent, the account was rejected, or it was decided elsewhere.",
      schema: z.object({}),
      effect: "idempotent_write",
      run: async (_args, sessionId, signal) => {
        const session = requireSession(sessionId);
        const [state, account] = await Promise.all([readReviewState(session), services.reviewApi.getAccount(accountIdOf(session), signal)]);
        if (account.status === "pending_approval") {
          refuse("the account is still waiting for a decision");
        }
        if (state.isApprovedHere && !state.hasSendAttempt) {
          refuse("the account was approved here; send the welcome email first");
        }
        return { status: "finished", accountStatus: account.status };
      },
    },
  ];
}

/**
 * A connector operation whose input the guard builds from the tool's arguments and the session's state. The call
 * identity, the dispatch fence and the retry rules stay the connector's own: the guard only runs first.
 */
function guarded<Input, Output>(
  operation: Mutation<Input, Output>,
  guard: (args: Record<string, unknown>, sessionId: string, signal: AbortSignal) => Promise<Input>,
): Mutation<Record<string, unknown>, Output> {
  return {
    definition: () => operation.definition(),
    idempotencyKey: (callId) => operation.idempotencyKey(callId, undefined as Input),
    invoke: async (call, args) => {
      let input: Input;
      try {
        input = await guard(args, call.context.flowId, call.context.cancellationSignal);
      } catch (error: unknown) {
        // Nothing was sent yet, so any guard failure is a definite failure the model reads.
        throw error instanceof ToolExecutionError ? error : new ToolExecutionError(`not sent: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
      }
      return operation.invoke(call, input);
    },
  };
}

/** The package manifest entry of `operationId`, offered under the tool's own arguments and description. */
function manifestFor(
  manifest: ConnectorPackageManifest,
  operationId: string,
  description: string,
  schema: z.ZodObject,
): ConnectorPackageManifest {
  const factory = manifest.factories.find((entry) => entry.operationId === operationId)!;
  return { connectorId: manifest.connectorId, factories: [{ ...factory, description, inputSchema: toolJsonSchema(schema) }] };
}

/** The tools that post to Slack or send the email, as Dex connector tools: each call is one connector call in its own Step. */
export function createSignupConnectorTools(services: SignupServices): ToolSource {
  const { slack, gmail } = services;
  const requireThread = (state: ReviewState) => state.thread ?? refuse("call post_review first");
  const reviewSchema = z.object({
    recommendation: z.enum(["approve", "reject"]),
    reasons: z.array(z.string().min(1).max(500)).min(1).max(6).describe("Facts you found, or what was missing."),
    emailSubject: z.string().min(1).max(200),
    emailBody: z.string().min(1).max(8_000),
  });
  const draftSchema = z.object({ subject: z.string().min(1).max(200), body: z.string().min(1).max(8_000) });
  const replySchema = z.object({ text: z.string().min(1).max(3_000) });

  const postReview = guarded(slack.operations.postChannelMessage(), async (args, sessionId, signal) => {
    const state = await readReviewState(sessionId);
    if (state.thread !== undefined) {
      refuse(`the review is already posted (thread ${state.thread.ts}); use post_draft or reply_in_thread`);
    }
    const review = reviewSchema.parse(args);
    const account = await services.reviewApi.getAccount(accountIdOf(sessionId), signal);
    return { channelId: services.slackChannelId, text: reviewPost(account, review, services.harnessLabel, sessionId) };
  });
  const postDraft = guarded(slack.operations.postThreadReply(), async (args, sessionId) => {
    const state = await readReviewState(sessionId);
    const thread = requireThread(state);
    const draft = draftSchema.parse(args);
    const text = `*[draft ${state.drafts.length + 1}]* *Subject:* ${draft.subject}\n${quote(draft.body)}\nReply \`send\` to send this draft once the account is approved, or write what to change.`;
    return { channelId: thread.channel, threadTimestamp: thread.ts, text };
  });
  const replyInThread = guarded(slack.operations.postThreadReply(), async (args, sessionId) => {
    const thread = requireThread(await readReviewState(sessionId));
    return { channelId: thread.channel, threadTimestamp: thread.ts, text: replySchema.parse(args).text };
  });
  const sendWelcomeEmail = guarded(gmail.operations.sendMessage(), async (_args, sessionId, signal) => {
    const state = await readReviewState(sessionId);
    if (state.hasSendAttempt) {
      refuse("send_welcome_email already ran; it never runs twice (if it failed, the email may have been sent: check Sent Mail)");
    }
    if (!state.isApprovedHere || (await services.reviewApi.getAccount(accountIdOf(sessionId), signal)).status !== "active") {
      refuse("the account is not approved");
    }
    const draft = state.drafts.at(-1) ?? refuse("no draft is posted");
    const replies = await readReviewerReplies(slack, sessionId, requireThread(state), services.reviewerSlackIds, signal);
    if (!replies.some((reply) => /^send[.!]?$/i.test(reply.text.trim()) && isLater(reply.timestamp, draft.ts))) {
      refuse("no reviewer has replied `send` after the latest draft");
    }
    const account = await services.reviewApi.getAccount(accountIdOf(sessionId), signal);
    return { to: [account.email], subject: draft.subject, textBody: draft.body };
  });

  const slackTool = (name: string, operationId: string, description: string, schema: z.ZodObject, operation: Mutation<Record<string, unknown>, unknown>) =>
    connectorTool(operation, slack.reference, {
      manifest: manifestFor(slackManifest, operationId, description, schema),
      inputValidator: schema,
      name,
      requiresApproval: false,
    });
  return new ConnectorToolSource([
    slackTool("post_review", "postChannelMessage", "Post the review to the admins' Slack channel. Once per review.", reviewSchema, postReview),
    slackTool("post_draft", "postThreadReply", "Post a new welcome email draft in the review thread.", draftSchema, postDraft),
    slackTool("reply_in_thread", "postThreadReply", "Post a short note in the review thread.", replySchema, replyInThread),
    connectorTool(sendWelcomeEmail, gmail.reference, {
      manifest: manifestFor(gmailManifest, "sendMessage", "Send the latest posted draft to the applicant. Allowed once, after the approval and a reviewer's `send`.", z.object({})),
      inputValidator: z.object({}),
      name: "send_welcome_email",
      requiresApproval: false,
    }),
  ]);
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function reviewPost(account: Account, review: { recommendation: string; reasons: string[]; emailSubject: string; emailBody: string }, harness: string, sessionId: string): string {
  return [
    `:wave: *New Dex Cloud sign-up:* ${account.displayName ?? "(no name)"} <${account.email}>`,
    `*Profile:* ${account.profileUrl ?? "(none)"} · *Signed up with:* ${account.signupMethod ?? "unknown"}`,
    `*Recommendation:* ${review.recommendation === "approve" ? ":white_check_mark: Approve" : ":x: Reject"}`,
    ...review.reasons.map((reason) => `• ${reason}`),
    `*[draft 1]* *Subject:* ${review.emailSubject}`,
    quote(review.emailBody),
    `*Reply in this thread:* \`approve\`, \`reject <reason>\`, or what to change in the email; after the approval, \`send\`.`,
    `_Reviewed by ${harness} · Dex session \`${sessionId}\`_`,
  ].join("\n");
}

/** JSON Schema of a tool's arguments, limited to the keywords Dex checks; zod checks the rest when the tool runs. */
export function toolJsonSchema(schema: z.ZodObject): Record<string, unknown> {
  const checked = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "description"]);
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map(strip);
    }
    if (typeof node !== "object" || node === null) {
      return node;
    }
    return Object.fromEntries(
      Object.entries(node)
        .filter(([key]) => checked.has(key))
        .map(([key, value]) => [key, key === "properties" ? Object.fromEntries(Object.entries(value as object).map(([name, child]) => [name, strip(child)])) : strip(value)]),
    );
  };
  return strip(z.toJSONSchema(schema)) as Record<string, unknown>;
}

/** Shared by the harness adapters: parse the arguments and turn a refusal or a lookup failure into model-visible text. */
export async function runSignupTool(tool: SignupTool, rawArgs: unknown, sessionId: string | undefined, signal: AbortSignal): Promise<string> {
  const parsed = tool.schema.safeParse(rawArgs);
  if (!parsed.success) {
    throw new ToolExecutionError(`invalid arguments for ${tool.name}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  try {
    return JSON.stringify(await tool.run(parsed.data as Record<string, unknown>, sessionId, signal));
  } catch (error: unknown) {
    if (error instanceof ToolExecutionError || tool.effect !== "read") {
      throw error;
    }
    // A read that failed, such as a 404 page, is information for the model, not a crash.
    throw new ToolExecutionError(`${tool.name} failed: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
  }
}

