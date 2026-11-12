// Entry point: the Worker, the Client and the SignupWatcher in one process.

import { newProjectConnection as newGmailConnection } from "@superdurable/connector-google-gmail";
import { newProjectConnection as newSlackConnection } from "@superdurable/connector-slack";
import { loadFromEnvironment } from "@superdurable/connectors-sdk/projectconfig";

import { createPiModelClient, createPiSignupAgentFlow } from "./agent/pi-signup-agent.js";
import { PublicProfileSources } from "./agent/profile-sources.js";
import type { SignupAgentSessionFlow } from "./agent/review-submission.js";
import { SignupAgentTools } from "./agent/signup-agent-tools.js";
import { startSignupApplication } from "./application.js";
import { ConnectionName, loadSignupAgentConfig } from "./config.js";
import { ReviewApiClient } from "./review-api/review-api-client.js";
import { SignupWatcher } from "./signup-watcher.js";
import { AgentHarness } from "./signup-review/signup-review-values.js";

const config = loadSignupAgentConfig();
// The connector configuration (DEX_CONNECTOR_CONFIG_FILE) holds the Slack and Gmail credentials; they never enter Flow state.
const project = await loadFromEnvironment();
const slack = newSlackConnection(project, ConnectionName.slack);
const gmail = newGmailConnection(project as unknown as Parameters<typeof newGmailConnection>[0], ConnectionName.gmail);
const reviewApi = new ReviewApiClient({ baseUrl: config.reviewApiUrl, apiKey: config.reviewApiKey });
const tools = new SignupAgentTools(new PublicProfileSources(config.githubToken === undefined ? {} : { githubToken: config.githubToken }));

const agentSessionFlows = new Map<AgentHarness, SignupAgentSessionFlow>([
  [AgentHarness.pi, createPiSignupAgentFlow(tools, createPiModelClient(config.piModel, config.anthropicApiKey))],
]);
if (!agentSessionFlows.has(config.harness)) {
  throw new Error(`the ${config.harness} harness is not built into this version`);
}

const application = await startSignupApplication(config.dex, {
  reviewApi,
  slack,
  gmail,
  agentSessionFlows,
  slackChannelId: config.slackChannelId,
  reviewerSlackIds: config.reviewerSlackIds,
});
console.log(`Signup agent ready on ${config.dex.serverAddress}; harness ${config.harness}; watching for pending sign-ups`);

const stopping = new AbortController();
const watcher = new SignupWatcher(application.client, application.signupReviewFlow, reviewApi, {
  intervalMs: config.watchIntervalMs,
  harness: config.harness,
});
const watching = watcher.run(stopping.signal);

let isStopping = false;
async function shutDown(): Promise<void> {
  if (isStopping) {
    return;
  }
  isStopping = true;
  console.log("Stopping: the reviews keep waiting in Dex and resume when the agent starts again");
  stopping.abort();
  await watching;
  await application.stop();
}
process.once("SIGINT", () => void shutDown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutDown().then(() => process.exit(0)));
