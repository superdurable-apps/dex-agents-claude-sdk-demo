// TEST ONLY: a scripted model that follows the agent's procedure, shared by the harness tests, and fixed profiles.

import type { GitHubUserSummary, ProfilePage, ProfileSources } from "../../src/profile-sources.js";

export type ScriptedStep = { readonly kind: "answer"; readonly text: string } | { readonly kind: "tool"; readonly name: string; readonly arguments: Record<string, unknown> };

/** A tool result the model has seen since the last user message. */
export interface SeenResult {
  readonly name: string;
  readonly output: string;
}

/** Applicants whose email contains this word get a reject recommendation. */
export const rejectedApplicantWord = "spammy";

/** Calls each tool of `plan` in turn, skipping the ones already called since the user message, then answers. */
function follow(plan: readonly ScriptedStep[], seen: readonly SeenResult[]): ScriptedStep {
  return plan[seen.length] ?? { kind: "answer", text: "Done." };
}

/** Decides the next step from the last user message and the tool results since then. */
export function decideNextStep(userText: string, seen: readonly SeenResult[]): ScriptedStep {
  const tool = (name: string, args: Record<string, unknown> = {}): ScriptedStep => ({ kind: "tool", name, arguments: args });
  const start = /^Review Dex Cloud account (\S+)/.exec(userText);
  if (start !== null) {
    const account = seen.find((result) => result.name === "get_account");
    const email = account === undefined ? "" : String((JSON.parse(account.output) as { email?: string }).email);
    const isRejected = email.includes(rejectedApplicantWord);
    return follow(
      [
        tool("get_account", { accountId: start[1] }),
        tool("github_user", { login: "ada-builds" }),
        tool("post_review", {
          recommendation: isRejected ? "reject" : "approve",
          reasons: isRejected ? ["The email domain is disposable"] : ["Maintains durable-queue (340 stars) on GitHub"],
          emailSubject: "Welcome to Dex Cloud",
          emailBody: "Hi Ada,\n\nWelcome to Dex Cloud (draft 1).\n\nThe Dex Cloud team",
        }),
      ],
      seen,
    );
  }
  const reply = /^\[(?:slack [\d.]+\] <@\w+>|test\]): ([\s\S]*)$/.exec(userText)?.[1]?.trim().toLowerCase();
  if (reply === "approve" || reply === "approve now") {
    return follow([tool("approve_account"), tool("reply_in_thread", { text: `approve_account: ${seen[0]?.output ?? ""}` })], seen);
  }
  if (reply?.startsWith("reject")) {
    return follow([tool("reject_account", { reason: reply.slice(6).trim() }), tool("reply_in_thread", { text: "Rejected." }), tool("finish_review")], seen);
  }
  if (reply === "send" || reply === "send now") {
    const isSent = seen[0] !== undefined && seen[0].output.includes("messageId");
    return follow([tool("send_welcome_email"), ...(isSent ? [tool("reply_in_thread", { text: "Sent." }), tool("finish_review")] : [])], seen);
  }
  if (userText.startsWith("[dex-cloud")) {
    return follow([tool("reply_in_thread", { text: "Decided in Dex Cloud admin; nothing more to do." }), tool("finish_review")], seen);
  }
  if (reply !== undefined) {
    const draft = { subject: "Welcome to Dex Cloud", body: `Hi Ada,\n\nWelcome to Dex Cloud. Revised: ${reply}\n\nThe Dex Cloud team` };
    return follow([tool("post_draft", draft)], seen);
  }
  return { kind: "answer", text: "ok" };
}

/** TEST ONLY: profile sources with fixed answers, so no test reaches the internet. */
export class FixtureProfileSources implements ProfileSources {
  public async fetchProfilePage(url: string): Promise<ProfilePage> {
    return { url, status: 200, title: "Ada's site", text: "Ada builds developer tools.", isTruncated: false };
  }

  public async fetchGitHubUser(login: string): Promise<GitHubUserSummary> {
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
