// Closed value sets and Attribute value types of SignupReviewFlow.

import type { Recommendation } from "../agent/review-submission.js";

/** Where one review stands. Final phases end the Flow. */
export const Phase = {
  analyzing: "analyzing",
  awaitingAccountDecision: "awaiting_account_decision",
  reviewingEmail: "reviewing_email",
  sending: "sending",
  done: "done",
  rejected: "rejected",
  superseded: "superseded",
  timedOut: "timed_out",
  failed: "failed",
} as const;
export type Phase = (typeof Phase)[keyof typeof Phase];

/** The phases a review ends in. */
export type FinalPhase = typeof Phase.done | typeof Phase.rejected | typeof Phase.superseded | typeof Phase.timedOut | typeof Phase.failed;

/** The agent harness that writes the review. */
export const AgentHarness = { pi: "pi", claudeAgentSdk: "claude-agent-sdk" } as const;
export type AgentHarness = (typeof AgentHarness)[keyof typeof AgentHarness];

/** Label of each harness in the Slack post. */
export const agentHarnessLabels: Readonly<Record<AgentHarness, string>> = {
  [AgentHarness.pi]: "pi (Dex built-in agent loop with pi-ai)",
  [AgentHarness.claudeAgentSdk]: "Claude Agent SDK (Claude Code CLI)",
};

/** Parses a harness name, such as the value of `SIGNUP_AGENT_HARNESS`. */
export function parseAgentHarness(value: string): AgentHarness {
  const harness = Object.values(AgentHarness).find((known) => known === value);
  if (harness === undefined) {
    throw new TypeError(`unknown agent harness ${value}; use ${Object.values(AgentHarness).join(" or ")}`);
  }
  return harness;
}

/** An administrator's account decision. */
export const AccountDecisionKind = { approved: "approved", rejected: "rejected" } as const;
export type AccountDecisionKind = (typeof AccountDecisionKind)[keyof typeof AccountDecisionKind];

/** Start input of SignupReviewFlow. */
export interface SignupReviewStart {
  readonly accountId: string;
  readonly harness: AgentHarness;
}

/** The agent's recommendation and reasons, from its first submission. */
export interface ReviewValue {
  readonly recommendation: Recommendation;
  readonly reasons: readonly string[];
}

/** The current welcome email draft. */
export interface DraftValue {
  readonly subject: string;
  readonly body: string;
  readonly version: number;
}

/** The draft version asked of the agent and the feedback sent with it. */
export interface RevisionValue {
  readonly requested: number;
  readonly feedback: string;
}

/** The review's Slack thread. */
export interface SlackThreadValue {
  readonly channel: string;
  readonly ts: string;
}

/** The administrator's decision. */
export interface DecisionValue {
  readonly decision: AccountDecisionKind;
  readonly slackUserId: string;
  readonly at: string;
  readonly reason: string;
}

/** The sent welcome email. */
export interface EmailValue {
  readonly gmailMessageId: string;
  readonly draftVersion: number;
  readonly sentAt: string;
}

/** Why a review failed, truncated. */
export interface FailureValue {
  readonly step: string;
  readonly detail: string;
}

/** What follows a thread reply. */
export type ReplyContinuation = { readonly kind: "awaitReply" } | { readonly kind: "finish"; readonly phase: FinalPhase };

/** Truncates provider or model text for Flow state and Slack. */
export function truncate(text: string, maxCharacters: number): string {
  return text.length <= maxCharacters ? text : `${text.slice(0, maxCharacters - 1)}…`;
}
