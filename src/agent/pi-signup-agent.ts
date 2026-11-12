// The pi harness: Dex runs the agent loop (the built-in loop), pi-ai makes each model call, Pi tools run as Steps.

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels, type BuiltinProvider } from "@earendil-works/pi-ai/providers/all";
import { arr, obj, oneOf, str } from "@earendil-works/pi-schema";
import { createBuiltinAgentSessionFlow, type ModelClient } from "@superdurable/dex-agents/builtin-loop";
import { createPiAiModelClient, piAgentFunctionTool } from "@superdurable/dex-agents-pi";

import { Recommendation, submitReviewDescription, submitReviewToolName, type SignupAgentSessionFlow } from "./review-submission.js";
import { signupAgentInstructions } from "./signup-agent-instructions.js";
import { signupAgentToolDescriptions, type SignupAgentTools, type SignupToolResult } from "./signup-agent-tools.js";

/** Flow type of the pi harness's agent sessions. */
export const piSignupAgentFlowType = "SignupReviewPiAgentFlow";

/** Default pi-ai model, `<provider>/<model ID>` of pi-ai's built-in catalog. */
export const defaultPiModelName = "anthropic/claude-opus-5-5";

/**
 * Looks a model up in pi-ai's built-in catalog. pi-ai reads the provider's key, such as `ANTHROPIC_API_KEY`, from the
 * Worker's environment at each call; the key never enters Flow state.
 */
export function loadPiModel(name: string): Model<Api> {
  const separator = name.indexOf("/");
  const provider = name.slice(0, separator) as BuiltinProvider;
  const modelId = name.slice(separator + 1);
  const model = separator > 0 ? getBuiltinModels(provider).find((candidate) => candidate.id === modelId) : undefined;
  if (model === undefined) {
    throw new Error(`pi model ${name} is not a <provider>/<model ID> of pi-ai's built-in catalog`);
  }
  return model;
}

const urlArguments = obj({ url: str({ description: "The https URL to fetch." }) });
const loginArguments = obj({ login: str({ description: "The GitHub login, without @." }) });
const reviewArguments = obj({
  recommendation: oneOf([Recommendation.approve, Recommendation.reject], { description: "Your recommendation." }),
  reasons: arr(str(), { minItems: 1, maxItems: 6, description: "One to six short reasons: facts you found, or what was missing." }),
  emailSubject: str({ description: "Subject of the welcome email." }),
  emailBody: str({ description: "Plain-text body of the welcome email, addressed to the applicant." }),
});

function toPiResult(result: SignupToolResult): AgentToolResult<undefined> {
  // isError makes the result a failed call that the model reads; the session continues.
  return "text" in result
    ? { content: [{ type: "text", text: result.text }], details: undefined }
    : { content: [{ type: "text", text: result.error }], details: undefined, isError: true };
}

/**
 * Builds the pi harness's session Flow. Every tool is a read, so each call runs in its own `CallTool` Step that Dex
 * may retry, without approval.
 * @param model - The model client; `createPiAiModelClient` of {@link loadPiModel} in production, a scripted client in tests.
 */
export function createPiSignupAgentFlow(tools: SignupAgentTools, model: ModelClient): SignupAgentSessionFlow {
  const fetchProfile: AgentTool<typeof urlArguments> = {
    name: "fetch_profile",
    label: "Fetch profile page",
    description: signupAgentToolDescriptions.fetch_profile,
    parameters: urlArguments,
    execute: async (_toolCallId, { url }, signal) => toPiResult(await tools.fetchProfile(url, signal ?? new AbortController().signal)),
  };
  const githubUser: AgentTool<typeof loginArguments> = {
    name: "github_user",
    label: "Look up GitHub user",
    description: signupAgentToolDescriptions.github_user,
    parameters: loginArguments,
    execute: async (_toolCallId, { login }, signal) => toPiResult(await tools.githubUser(login, signal ?? new AbortController().signal)),
  };
  const submitReview: AgentTool<typeof reviewArguments> = {
    name: submitReviewToolName,
    label: "Submit review",
    description: submitReviewDescription,
    parameters: reviewArguments,
    execute: async (_toolCallId, review) => toPiResult(tools.submitReview(review)),
  };
  return createBuiltinAgentSessionFlow(
    {
      name: "signup-review",
      instructions: signupAgentInstructions,
      model,
      tools: [
        piAgentFunctionTool(fetchProfile, { effect: "read" }),
        piAgentFunctionTool(githubUser, { effect: "read" }),
        // No external effect: the review Flow reads the arguments from the session.
        piAgentFunctionTool(submitReview, { effect: "read" }),
      ],
    },
    piSignupAgentFlowType,
  );
}

/** The production model client of the pi harness. */
export function createPiModelClient(modelName: string, apiKey: string | undefined): ModelClient {
  return createPiAiModelClient(loadPiModel(modelName), apiKey === undefined ? {} : { apiKey });
}
