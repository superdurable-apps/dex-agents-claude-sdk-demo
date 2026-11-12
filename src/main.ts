// The Worker process: the review agent's session Flow, a Dex Client, and the two polling loops.

import { newProjectConnection as newGmailConnection } from "@superdurable/connector-google-gmail";
import { newProjectConnection as newSlackConnection } from "@superdurable/connector-slack";
import { loadFromEnvironment } from "@superdurable/connectors-sdk/projectconfig";
import { Client, Registry, Worker, openBlobCache } from "@superdurable/dex";

import { loadSignupAgentConfig } from "./config.js";
import { createPiSignupAgent, piHarnessLabel, piModel } from "./pi-agent.js";
import { PublicProfileSources } from "./profile-sources.js";
import { dex } from "./review-state.js";
import { ReviewApiClient } from "./review-api.js";
import type { SignupServices } from "./signup-agent.js";
import { runSignupLoops } from "./signup-loops.js";

const config = loadSignupAgentConfig();
// DEX_CONNECTOR_CONFIG_FILE names the connector configuration with the Slack and Gmail credentials.
const project = await loadFromEnvironment();
const services: SignupServices = {
  reviewApi: new ReviewApiClient({ baseUrl: config.reviewApiUrl, apiKey: config.reviewApiKey }),
  profiles: new PublicProfileSources(config.githubToken === undefined ? {} : { githubToken: config.githubToken }),
  slack: newSlackConnection(project, "review-slack"),
  gmail: newGmailConnection(project as unknown as Parameters<typeof newGmailConnection>[0], "welcome-gmail"),
  slackChannelId: config.slackChannelId,
  reviewerSlackIds: config.reviewerSlackIds,
  harnessLabel: piHarnessLabel,
};

const flow = createPiSignupAgent(services, piModel(config.piModel));
const registry = new Registry([flow]);
const blobCache = openBlobCache({ directory: config.dex.blobCacheDirectory, maxBytes: 256 * 1024 * 1024 });
const worker = new Worker(registry, blobCache, config.dex.options);
await worker.start();
await worker.waitPullRegistered({ timeoutMs: 30_000 });
dex.client = new Client(registry, blobCache, config.dex.options);
dex.flow = flow;
console.log(`Signup review agent (${flow.getFlowType()}) is running on ${config.dex.options.serverAddress}`);

const stopping = new AbortController();
const loops = runSignupLoops(services, { watchMs: config.watchIntervalMs, relayMs: 15_000 }, stopping.signal);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.log("Stopping; the reviews wait in Dex and go on when the agent starts again");
    stopping.abort();
    void loops.then(async () => {
      await worker.close();
      await dex.client?.close();
      blobCache.close();
      process.exit(0);
    });
  });
}
