// TEST ONLY: a scripted model that follows the agent's procedure, shared by the harness tests, and fixed profiles.

import type { GitHubUserSummary, ProfilePage, ProfileSources } from "../../src/profile-sources.js";

/** One scripted model response: an answer, tool calls (several in one response when asked), or a failed call. */
export type ScriptedStep =
  | { readonly kind: "answer"; readonly text: string }
  | { readonly kind: "tools"; readonly calls: readonly { readonly name: string; readonly arguments: Record<string, unknown> }[] }
  | { readonly kind: "fail" };

/** A tool result the model has seen since the last user message. */
export interface SeenResult {
  readonly name: string;
  readonly output: string;
}

/** Applicants whose email contains this word get a reject recommendation. */
export const rejectedApplicantWord = "spammy";
/** Applicants whose email contains this word make the model only note Slack replies, never act on them. */
export const passiveApplicantWord = "passive";
/** Applicants whose email contains this word make the model post a draft and a note in one response. */
export const multiCallApplicantWord = "multi";
/** Applicants whose email contains this word make the first turn fail, and its first retry too. */
export const firstTurnFailingWord = "firstfail";
/** Applicants whose email contains this word make the turn of the reviewer's "Shorter" fail once. */
export const laterTurnFailingWord = "laterfail";

/** Runs each response of `plan` in turn, skipping the calls already made since the user message, then answers. */
function follow(plan: readonly ScriptedStep[], seen: readonly SeenResult[]): ScriptedStep {
  let made = 0;
  for (const step of plan) {
    if (made >= seen.length) {
      return step;
    }
    made += step.kind === "tools" ? step.calls.length : 1;
  }
  return { kind: "answer", text: "Done." };
}

const tool = (name: string, args: Record<string, unknown> = {}): ScriptedStep => ({ kind: "tools", calls: [{ name, arguments: args }] });
const tools = (...steps: ScriptedStep[]): ScriptedStep => ({ kind: "tools", calls: steps.flatMap((step) => (step.kind === "tools" ? step.calls : [])) });

/** Decides the next step from the session's user messages, oldest first, and the tool results since the last one. */
export function decideNextStep(rawUserTexts: readonly string[], seen: readonly SeenResult[]): ScriptedStep {
  // A retry message quotes the failed turn's message after its first line; the model handles that message as new.
  const isRetry = (text: string) => text.startsWith("[retry ");
  const userTexts = rawUserTexts.map((text) => (isRetry(text) ? text.slice(text.indexOf("\n") + 1) : text));
  const retries = rawUserTexts.filter(isRetry).length;
  const isRetryTurn = isRetry(rawUserTexts.at(-1) ?? "");
  const userText = userTexts.at(-1) ?? "";
  const first = userTexts.find((text) => text.startsWith("Review Dex Cloud account")) ?? "";
  const facts = JSON.parse(first.slice(first.indexOf("{"), first.lastIndexOf("}") + 1) || "{}") as { email?: string; profileUrl?: string };
  const email = facts.email ?? "";
  // Injected model failures: every model call of a turn fails, so the turn fails, until enough retries arrived.
  if (seen.length === 0 && email.includes(firstTurnFailingWord) && userText === first && retries < 2) {
    return { kind: "fail" };
  }
  if (seen.length === 0 && email.includes(laterTurnFailingWord) && /^\[slack [\d.]+\] <@\w+>: shorter$/i.test(userText) && retries < 1) {
    return { kind: "fail" };
  }
  if (userText === first) {
    const login = /github\.com\/([A-Za-z0-9-]+)/.exec(facts.profileUrl ?? "")?.[1] ?? "ada-builds";
    const isRejected = email.includes(rejectedApplicantWord);
    const review = tool("post_review", {
      recommendation: isRejected ? "reject" : "approve",
      reasons: isRejected ? ["The email domain is disposable"] : ["Maintains <durable-queue> & more (340 stars) on GitHub"],
      emailSubject: "Welcome to Dex Cloud",
      emailBody: "Hi Ada,\n\nWelcome to Dex Cloud (draft 1).\n\nThe Dex Cloud team",
    });
    return follow([tool("github_user", { login }), review], seen);
  }
  const slackTs = /^\[slack ([\d.]+)\]/.exec(userText)?.[1];
  if (slackTs !== undefined && !isRetryTurn && userTexts.slice(0, -1).some((text) => text.startsWith(`[slack ${slackTs}]`))) {
    // As the prompt says: a repeated ts is ignored.
    return { kind: "answer", text: "Already handled." };
  }
  const slack = /^\[slack [\d.]+\] <@\w+>: ([\s\S]*)$/.exec(userText)?.[1];
  if (slack !== undefined && email.includes(passiveApplicantWord)) {
    return { kind: "answer", text: "Noted." };
  }
  const reply = slack?.trim().toLowerCase();
  if (reply === "approve") {
    // The tool posts its own confirmation; the model says nothing more.
    return follow([tool("approve_account")], seen);
  }
  if (reply?.startsWith("reject ")) {
    const isRejected = seen[0]?.output.includes('"rejected"') === true;
    return follow([tool("reject_account", { reason: slack!.trim().slice("reject ".length) }), ...(isRejected ? [tool("reply_in_thread", { text: "Review done: rejected." }), tool("finish_review")] : [])], seen);
  }
  if (reply === "send") {
    const isSent = seen[0]?.output.includes("messageId") === true;
    const isRefused = seen[0]?.output.includes("refused: ") === true;
    return follow([tool("send_welcome_email"), ...(isRefused ? [] : [tool("reply_in_thread", { text: isSent ? "Review done: approved and welcomed." : "Review done: approved; the email may not have gone out." }), tool("finish_review")])], seen);
  }
  if (userText.startsWith("[dex-cloud")) {
    // A status its own approve or reject explains is the model's own decision: it carries on.
    const replies = userTexts.map((text) => /^\[slack [\d.]+\] <@\w+>: ([\s\S]*)$/.exec(text)?.[1]?.trim().toLowerCase() ?? "");
    const isOwn = userText.startsWith("[dex-cloud active]") ? replies.includes("approve") : userText.startsWith("[dex-cloud rejected]") && replies.some((text) => text.startsWith("reject "));
    if (isOwn) {
      return { kind: "answer", text: "That is my own decision." };
    }
    return follow([tool("reply_in_thread", { text: "Decided in Dex Cloud admin; nothing more to do." }), tool("finish_review")], seen);
  }
  if (reply === "hold") {
    return { kind: "answer", text: "Holding." };
  }
  if (reply !== undefined) {
    const draft = tool("post_draft", { subject: "Welcome to Dex Cloud", body: `Hi Ada,\n\nWelcome to Dex Cloud. Revised: ${reply}\n\nThe Dex Cloud team` });
    return follow([email.includes(multiCallApplicantWord) ? tools(draft, tool("reply_in_thread", { text: "Here is the new draft." })) : draft], seen);
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
