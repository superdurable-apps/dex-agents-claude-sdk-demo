// The Worker process: the review agent's session Flow, the thread-watch Flow, a Dex Client, and the SignupWatcher.

import { newProjectConnection as newGmailConnection } from "@superdurable/connector-google-gmail";
import { newProjectConnection as newSlackConnection } from "@superdurable/connector-slack";
import { loadFromEnvironment } from "@superdurable/connectors-sdk/projectconfig";
import { Client, Registry, Worker, openBlobCache } from "@superdurable/dex";

import { loadSignupAgentConfig } from "./config.js";
import { createPiSignupAgent, piHarnessLabel, piModel } from "./pi-agent.js";
import { PublicProfileSources } from "./profile-sources.js";
import { ReviewApiClient } from "./review-api.js";
import { ReviewSessions } from "./review-state.js";
import type { SignupServices } from "./signup-agent.js";
import { runSignupWatcher } from "./signup-watcher.js";
import { SignupThreadWatchFlow } from "./thread-watch-flow.js";

const config = loadSignupAgentConfig();
// DEX_CONNECTOR_CONFIG_FILE names the connector configuration with the Slack and Gmail credentials.
const project = await loadFromEnvironment();
const services: SignupServices = {
  sessions: new ReviewSessions(config.reviewerSlackIds),
  reviewApi: new ReviewApiClient({ baseUrl: config.reviewApiUrl, apiKey: config.reviewApiKey }),
  profiles: new PublicProfileSources(config.githubToken === undefined ? {} : { githubToken: config.githubToken }),
  slack: newSlackConnection(project, "review-slack"),
  gmail: newGmailConnection(project, "welcome-gmail"),
  slackChannelId: config.slackChannelId,
  harnessLabel: piHarnessLabel,
};

const sessionFlow = createPiSignupAgent(services, piModel(config.piModel));
let client: Client | undefined;
const threadWatchFlow = new SignupThreadWatchFlow({
  ...services,
  reviewerSlackIds: config.reviewerSlackIds,
  client: () => client!,
  pollIntervalMs: config.threadPollIntervalMs,
});
const registry = new Registry([sessionFlow, threadWatchFlow]);
const blobCache = openBlobCache({ directory: config.dex.blobCacheDirectory, maxBytes: 256 * 1024 * 1024 });
// The Client exists before the Worker takes Steps, which use it.
client = new Client(registry, blobCache, config.dex.options);
services.sessions.connect(client, sessionFlow);
const worker = new Worker(registry, blobCache, config.dex.options);
await worker.start();
await worker.waitPullRegistered({ timeoutMs: 30_000 });
console.log(`Signup review agent (${sessionFlow.getFlowType()}) is running on ${config.dex.options.serverAddress}`);

const stopping = new AbortController();
const watching = runSignupWatcher(
  { client, sessionFlow, threadWatchFlow, reviewApi: services.reviewApi, reviewSince: config.reviewSince },
  config.watchIntervalMs,
  stopping.signal,
);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.log("Stopping; the reviews wait in Dex and go on when the agent starts again");
    stopping.abort();
    void watching.then(async () => {
      await worker.close();
      await client?.close();
      blobCache.close();
      process.exit(0);
    });
  });
}
