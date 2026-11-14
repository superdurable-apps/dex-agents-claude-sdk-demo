// The Worker process: the review agent's session Flow, a Dex Client, the SignupWatcher, and the Slack reply Trigger.

import { newProjectConnection as newGmailConnection } from "@superdurable/connector-google-gmail";
import { newProjectConnection as newSlackConnection } from "@superdurable/connector-slack";
import { TriggerDeliveryAbortedError, newTriggerContext } from "@superdurable/connectors-sdk";
import { loadFromEnvironment } from "@superdurable/connectors-sdk/projectconfig";
import { Client, Registry, Worker, openBlobCache } from "@superdurable/dex";

import { claudeCliEnvironment, claudeHarnessLabel, createClaudeSignupAgent } from "./claude-agent.js";
import { loadSignupAgentConfig } from "./config.js";
import { createPiSignupAgent, piHarnessLabel, piModel } from "./pi-agent.js";
import { PublicProfileSources } from "./profile-sources.js";
import { ReviewApiClient } from "./review-api.js";
import { createReviewReplyRunner, createReviewReplyTarget, reviewSlackConnection } from "./review-replies.js";
import { ReviewSessions } from "./review-state.js";
import type { SignupServices } from "./signup-agent.js";
import { runSignupWatcher } from "./signup-watcher.js";

const config = loadSignupAgentConfig();
// DEX_CONNECTOR_CONFIG_FILE names the connector configuration with the Slack and Gmail credentials.
const project = await loadFromEnvironment();
const services: SignupServices = {
  sessions: new ReviewSessions(),
  reviewApi: new ReviewApiClient({ baseUrl: config.reviewApiUrl, apiKey: config.reviewApiKey }),
  profiles: new PublicProfileSources(config.githubToken === undefined ? {} : { githubToken: config.githubToken }),
  slack: newSlackConnection(project, reviewSlackConnection),
  gmail: newGmailConnection(project, "welcome-gmail"),
  slackChannelId: config.slackChannelId,
  harnessLabel: config.harness === "claude-agent-sdk" ? claudeHarnessLabel : piHarnessLabel,
};

// SIGNUP_AGENT_HARNESS picks the harness; the prompt, the tools and the reply Trigger are the same for both.
const sessionFlow =
  config.harness === "claude-agent-sdk"
    ? createClaudeSignupAgent(services, {
        model: config.claudeModel,
        cliEnvironment: claudeCliEnvironment(config.claudeAuthentication),
        ...(config.claudeCliPath === undefined ? {} : { cliPath: config.claudeCliPath }),
      })
    : createPiSignupAgent(services, piModel(config.piModel));
const registry = new Registry([sessionFlow]);
const blobCache = openBlobCache({ directory: config.dex.blobCacheDirectory, maxBytes: 256 * 1024 * 1024 });
const client = new Client(registry, blobCache, config.dex.options);
services.sessions.connect(client, sessionFlow);
const worker = new Worker(registry, blobCache, { ...config.dex.options, pull: { maxConcurrentTasks: config.workerSlots } });
await worker.start();
await worker.waitPullRegistered({ timeoutMs: 30_000 });
console.log(`Signup review agent (${sessionFlow.getFlowType()}) is running on ${config.dex.options.serverAddress}`);

const stopping = new AbortController();
const watching = runSignupWatcher({ client, sessionFlow, reviewApi: services.reviewApi, reviewSince: config.reviewSince }, config.watchIntervalMs, stopping.signal);
// The review-slack connection's app_token makes the runner use Slack Socket Mode.
const channel = { channelId: config.slackChannelId, reviewerIds: config.reviewerSlackIds };
const replies = createReviewReplyRunner(project, channel, createReviewReplyTarget({ client, sessionFlow, sessions: services.sessions, channel }))
  .run(newTriggerContext(stopping.signal))
  .catch((error: unknown) => {
    if (error instanceof TriggerDeliveryAbortedError && stopping.signal.aborted) {
      return;
    }
    console.error(`The Slack reply Trigger stopped: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    stop();
  });

function stop(): void {
  if (stopping.signal.aborted) {
    return;
  }
  console.log("Stopping; the reviews wait in Dex and go on when the agent starts again");
  stopping.abort();
  void Promise.all([watching, replies]).then(async () => {
    await worker.close();
    await client.close();
    blobCache.close();
    process.exit();
  });
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, stop);
}
