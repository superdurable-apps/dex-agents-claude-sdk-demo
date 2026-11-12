// TEST ONLY: the scripted agent behavior shared by every harness's test, and fixed profile sources.

import type { GitHubUserSummary, ProfilePage, ProfileSources } from "../../src/agent/profile-sources.js";
import { submitReviewToolName } from "../../src/agent/review-submission.js";

/** What the scripted model does next. */
export type ScriptedSignupReply =
  | { readonly kind: "answer"; readonly text: string }
  | { readonly kind: "toolCall"; readonly toolName: string; readonly arguments: Record<string, unknown> };

/** An applicant whose email contains this word gets a reject recommendation. */
export const rejectedApplicantWord = "spammy";
/** An applicant whose email contains this word makes the model forget submit_review once, so a reminder follows. */
export const forgetfulApplicantWord = "forgetful";

/**
 * Decides the scripted model's next step from the latest user message and the tools called since then:
 * look the applicant up, submit the review, then answer.
 */
export function decideSignupReply(userTexts: readonly string[], toolNamesSinceUser: readonly string[]): ScriptedSignupReply {
  const userText = userTexts.at(-1) ?? "";
  const firstRequest = userTexts.find((text) => text.startsWith("[draft 1]")) ?? "";
  const header = /^\[draft (\d+)( reminder)?\]/.exec(userText);
  if (header === null) {
    return { kind: "answer", text: "ok" };
  }
  const version = Number(header[1]);
  const isReminder = header[2] !== undefined;
  if (toolNamesSinceUser.includes(submitReviewToolName)) {
    return { kind: "answer", text: `Submitted draft ${version}.` };
  }
  const facts = JSON.parse(firstRequest.slice(firstRequest.indexOf("{"), firstRequest.lastIndexOf("}") + 1) || "{}") as {
    email: string;
    displayName: string | null;
    profileUrl: string | null;
  };
  if (version === 1 && isReminder) {
    return { kind: "toolCall", toolName: submitReviewToolName, arguments: reviewOf(facts.email, facts.displayName, 1, "") };
  }
  if (version === 1) {
    if (toolNamesSinceUser.length === 0) {
      const login = /github\.com\/([A-Za-z0-9-]+)/.exec(facts.profileUrl ?? "")?.[1];
      return login !== undefined
        ? { kind: "toolCall", toolName: "github_user", arguments: { login } }
        : { kind: "toolCall", toolName: "fetch_profile", arguments: { url: facts.profileUrl ?? "https://example.com" } };
    }
    if (facts.email.includes(forgetfulApplicantWord)) {
      return { kind: "answer", text: "This applicant looks fine to me." };
    }
    return { kind: "toolCall", toolName: submitReviewToolName, arguments: reviewOf(facts.email, facts.displayName, 1, "") };
  }
  const feedback = userText.split("\n")[2] ?? "";
  return { kind: "toolCall", toolName: submitReviewToolName, arguments: reviewOf(facts.email ?? "", facts.displayName, version, feedback) };
}

function reviewOf(email: string, name: string | null, version: number, feedback: string): Record<string, unknown> {
  const isRejected = (email ?? "").includes(rejectedApplicantWord);
  return {
    recommendation: isRejected ? "reject" : "approve",
    reasons: isRejected ? ["The email domain is disposable", "No profile information was found"] : ["GitHub user with 12 public repositories", "Maintains durable-queue (340 stars)"],
    emailSubject: "Welcome to Dex Cloud",
    emailBody: `Hi ${name ?? "there"},\n\nWelcome to Dex Cloud (draft ${version}).${feedback === "" ? "" : ` Revised: ${feedback}`}\n\nThe Dex Cloud team`,
  };
}

/** TEST ONLY: profile sources with fixed answers, so no test reaches the internet. */
export class FixtureProfileSources implements ProfileSources {
  public readonly calls: string[] = [];

  public async fetchProfilePage(url: string): Promise<ProfilePage> {
    this.calls.push(`page ${url}`);
    return { url, status: 200, title: "Ada's site", text: "Ada builds developer tools.", isTruncated: false };
  }

  public async fetchGitHubUser(login: string): Promise<GitHubUserSummary> {
    this.calls.push(`github ${login}`);
    return {
      login,
      name: "Ada Lovelace",
      bio: "Building durable things",
      company: null,
      blog: null,
      location: null,
      followers: 80,
      publicRepos: 12,
      createdAt: "2015-01-01T00:00:00Z",
      htmlUrl: `https://github.com/${login}`,
      topRepositories: [{ name: "durable-queue", description: "A queue", language: "Rust", stars: 340, pushedAt: null, isFork: false }],
    };
  }
}
