// The Slack messages of a review and the commands administrators reply with.

import type { Account } from "../review-api/review-api-client.js";
import { agentHarnessLabels, type AgentHarness, type DraftValue, type ReviewValue } from "./signup-review-values.js";

/** Slack's text limit is 40,000 characters; posts stay well below it. */
const maxPostCharacters = 12_000;

/** The footer of the root post: the review's identity, so a person can find the Flow. */
export function reviewFooter(flowId: string): string {
  return `_Dex Flow \`${flowId}\`_`;
}

/** The marker of the Flow's thread reply number `seq`, which identifies it when a post outcome is uncertain. */
export function replyMarker(accountId: string, seq: number): string {
  return `[signup-review-${accountId} #${seq}]`;
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function describeApplicant(account: Account): string {
  return [
    `*Name:* ${account.displayName ?? "(not given)"}`,
    `*Email:* ${account.email}`,
    `*Profile:* ${account.profileUrl ?? "(not given)"}`,
    `*Signed up with:* ${account.signupMethod ?? "(unknown)"} on ${account.registeredAt}`,
  ].join("\n");
}

function describeDraft(draft: DraftValue): string {
  return [`*Welcome email draft v${draft.version}*`, `*Subject:* ${draft.subject}`, quote(draft.body)].join("\n");
}

/** The root post: applicant, recommendation, reasons, draft, harness and the instructions. */
export function buildReviewPost(input: {
  readonly flowId: string;
  readonly account: Account;
  readonly review: ReviewValue;
  readonly draft: DraftValue;
  readonly harness: AgentHarness;
  readonly isRepost: boolean;
}): string {
  const lines = [
    ...(input.isRepost ? ["_Reposted: an earlier post of this review may not have arrived, or may appear twice. Reply in this thread._", ""] : []),
    `:wave: *New Dex Cloud sign-up to review*`,
    describeApplicant(input.account),
    "",
    `*Agent recommendation:* ${input.review.recommendation === "approve" ? ":white_check_mark: Approve" : ":x: Reject"}`,
    ...input.review.reasons.map((reason) => `• ${reason}`),
    "",
    describeDraft(input.draft),
    "",
    `*Reviewed by:* ${agentHarnessLabels[input.harness]}`,
    "*Reply in this thread:* `approve` to approve the account, `reject <reason>` to reject it, or write what to change in the email.",
    reviewFooter(input.flowId),
  ];
  return truncateMessage(lines.join("\n"));
}

/** The reply that shows a revised draft. */
export function buildDraftReply(draft: DraftValue, isAccountApproved: boolean): string {
  const next = isAccountApproved
    ? "Reply `send` to send it, or write what to change."
    : "Reply `approve` or `reject <reason>` to decide on the account, or write what to change.";
  return truncateMessage([describeDraft(draft), next].join("\n"));
}

/** Appends the marker to a thread reply. */
export function withReplyMarker(text: string, marker: string): string {
  return `${truncateMessage(text)}\n${marker}`;
}

function truncateMessage(text: string): string {
  return text.length <= maxPostCharacters ? text : `${text.slice(0, maxPostCharacters - 40)}\n… (truncated)`;
}

/** What an administrator's reply asks for. */
export type ReviewCommand =
  | { readonly kind: "approve" }
  | { readonly kind: "reject"; readonly reason: string }
  | { readonly kind: "send" }
  | { readonly kind: "feedback"; readonly text: string };

/** Reads one reply: `approve`, `reject <reason>`, `send`, or anything else as feedback on the email. */
export function parseReviewCommand(rawText: string): ReviewCommand | undefined {
  // Slack escapes &, < and >; mentions and links stay as written.
  const text = rawText.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();
  if (text === "") {
    return undefined;
  }
  if (/^approve[.!]?$/i.test(text)) {
    return { kind: "approve" };
  }
  if (/^send[.!]?$/i.test(text)) {
    return { kind: "send" };
  }
  const rejection = /^reject\b[\s:,-]*([\s\S]*)$/i.exec(text);
  if (rejection !== null) {
    return { kind: "reject", reason: rejection[1]?.trim() || "no reason given" };
  }
  return { kind: "feedback", text };
}
