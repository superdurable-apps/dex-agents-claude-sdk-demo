// The agent's tools, written once and wrapped by each harness: two reads and the structured result.

import { ProfileSourceError, type ProfileSources } from "./profile-sources.js";
import { parseReviewSubmission } from "./review-submission.js";

/** Tool names and the descriptions the model sees. */
export const signupAgentToolDescriptions = {
  fetch_profile:
    "Fetch a public HTTPS page, such as the applicant's personal website or profile link, and return its title and visible text (at most 1 MB read). Private and local addresses are refused.",
  github_user:
    "Look up a GitHub user by login with the GitHub public API: name, bio, company, blog, followers, account age, and their most starred repositories.",
} as const;

/** The outcome of one tool call: text for the model, or a failure the model reads. */
export type SignupToolResult = { readonly text: string } | { readonly error: string };

/** Runs the agent's tools against the given sources. Every tool is a read, so Dex may retry it. */
export class SignupAgentTools {
  public constructor(private readonly sources: ProfileSources) {}

  public async fetchProfile(url: string, signal: AbortSignal): Promise<SignupToolResult> {
    try {
      return { text: JSON.stringify(await this.sources.fetchProfilePage(url, signal)) };
    } catch (error: unknown) {
      return { error: describeFailure(error) };
    }
  }

  public async githubUser(login: string, signal: AbortSignal): Promise<SignupToolResult> {
    try {
      return { text: JSON.stringify(await this.sources.fetchGitHubUser(login.replace(/^@/, ""), signal)) };
    } catch (error: unknown) {
      return { error: describeFailure(error) };
    }
  }

  /** Checks a submission. The review Flow reads the arguments from the session, so nothing is stored here. */
  public submitReview(argumentsValue: unknown): SignupToolResult {
    const parsed = parseReviewSubmission(argumentsValue);
    return "submission" in parsed ? { text: "Review recorded. The admins will see it in Slack." } : { error: parsed.error };
  }
}

function describeFailure(error: unknown): string {
  if (error instanceof ProfileSourceError) {
    return error.message;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return "the request timed out";
  }
  return `the lookup failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}`;
}
