// The agent's structured result: the submit_review tool's arguments, and how the review Flow finds them.

import type { AgentFrameworkRunner, AgentMessage, AgentSessionFlow, AgentSnapshot, DeferredToolOutcome } from "@superdurable/dex-agents";
import { z } from "zod";

/** An agent session Flow of any harness, as the review Flow calls it. */
export type SignupAgentSessionFlow = AgentSessionFlow<AgentFrameworkRunner<DeferredToolOutcome>>;

/** Name of the tool the agent submits its review with. */
export const submitReviewToolName = "submit_review";

/** The agent's recommendation. */
export const Recommendation = { approve: "approve", reject: "reject" } as const;
export type Recommendation = (typeof Recommendation)[keyof typeof Recommendation];

/** Arguments of `submit_review`, checked by the tool and again by the review Flow. */
export const ReviewSubmissionSchema = z
  .object({
    recommendation: z.enum([Recommendation.approve, Recommendation.reject]),
    reasons: z.array(z.string().trim().min(1).max(500)).min(1).max(6),
    emailSubject: z.string().trim().min(1).max(200),
    emailBody: z.string().trim().min(1).max(5_000),
  })
  .strict();
export type ReviewSubmission = z.infer<typeof ReviewSubmissionSchema>;

/** JSON Schema of the `submit_review` arguments, as the model sees it. */
export const reviewSubmissionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["recommendation", "reasons", "emailSubject", "emailBody"],
  properties: {
    recommendation: { type: "string", enum: [Recommendation.approve, Recommendation.reject], description: "Your recommendation." },
    reasons: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      items: { type: "string" },
      description: "One to six short reasons, each a fact you found or the information that was missing.",
    },
    emailSubject: { type: "string", description: "Subject of the welcome email." },
    emailBody: { type: "string", description: "Plain-text body of the welcome email, addressed to the applicant." },
  },
} as const;

/** Description of `submit_review` for the model. */
export const submitReviewDescription =
  "Submit your review of the applicant: the recommendation, the reasons, and the welcome email draft. " +
  "Call it exactly once at the end of every turn, also after a revision request.";

/**
 * Checks raw `submit_review` arguments.
 * @returns The submission, or an error text that tells the model what to fix.
 */
export function parseReviewSubmission(value: unknown): { readonly submission: ReviewSubmission } | { readonly error: string } {
  const parsed = ReviewSubmissionSchema.safeParse(value);
  if (parsed.success) {
    return { submission: parsed.data };
  }
  const problems = parsed.error.issues.map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`);
  return { error: `submit_review arguments are invalid: ${problems.join("; ")}` };
}

/** The tool name without a harness prefix: the Claude Code CLI names custom tools `mcp__<server>__<tool>`. */
export function bareToolName(name: string): string {
  return name.split("__").at(-1) ?? name;
}

/** What the review Flow reads from a session after a turn. */
export type TurnReading =
  | { readonly kind: "running" }
  | { readonly kind: "submitted"; readonly submission: ReviewSubmission }
  | { readonly kind: "noSubmission"; readonly turnId: string; readonly lastTurnError: string | null }
  | { readonly kind: "sessionFailed"; readonly reason: string };

/**
 * Reads the turn whose user message starts with `marker`: whether it still runs, and the last valid `submit_review` it
 * made. The marker makes the request findable, so a message sent twice by a retried Step is never needed.
 */
export function readTurn(snapshot: AgentSnapshot, marker: string): TurnReading {
  const state = snapshot.state;
  if (state?.status === "failed") {
    return { kind: "sessionFailed", reason: state.lastTurnError ?? "the agent session failed" };
  }
  const request = findRequestMessage(snapshot.messages, marker);
  if (state === null || request === undefined) {
    return { kind: "running" };
  }
  const turnNumber = Number.parseInt(request.turnId.replace(/^turn-/, ""), 10);
  const isTurnDone = state.turnCount >= turnNumber && state.status === "waiting_for_user_message" && state.activeTurnId === null;
  if (!isTurnDone) {
    return { kind: "running" };
  }
  const submissions = snapshot.messages
    .filter((message) => message.turnId === request.turnId && message.sequence > request.sequence)
    .filter((message) => message.toolName !== null && bareToolName(message.toolName) === submitReviewToolName)
    .filter((message) => message.toolArguments !== null)
    .map((message) => parseSubmissionArguments(message.toolArguments ?? ""))
    .filter((submission): submission is ReviewSubmission => submission !== undefined);
  const submission = submissions.at(-1);
  if (submission !== undefined) {
    return { kind: "submitted", submission };
  }
  return { kind: "noSubmission", turnId: request.turnId, lastTurnError: state.lastTurnError };
}

/** Whether the session already holds or queues a user message that starts with `marker`. */
export function hasRequestMessage(snapshot: AgentSnapshot, marker: string): boolean {
  return (
    findRequestMessage(snapshot.messages, marker) !== undefined ||
    (snapshot.queuedMessages ?? []).some((pending) => pending.message.text.startsWith(marker)) ||
    (snapshot.steeredMessages ?? []).some((pending) => pending.message.text.startsWith(marker))
  );
}

function findRequestMessage(messages: readonly AgentMessage[], marker: string): AgentMessage | undefined {
  return messages.find((message) => message.role === "user" && message.origin === undefined && (message.text ?? "").startsWith(marker));
}

function parseSubmissionArguments(text: string): ReviewSubmission | undefined {
  try {
    const parsed = parseReviewSubmission(JSON.parse(text) as unknown);
    return "submission" in parsed ? parsed.submission : undefined;
  } catch {
    return undefined;
  }
}
