// Process configuration from environment variables (and `.env` through `node --env-file`). Secrets are never logged.

import { ApiKeyCredential, type Credential, type FlowServiceTlsOptions } from "@superdurable/dex";

import { defaultPiModelName } from "./agent/pi-signup-agent.js";
import { AgentHarness, parseAgentHarness } from "./signup-review/signup-review-values.js";

/** Static names of the connector connections in the Dex connector configuration. */
export const ConnectionName = { slack: "review-slack", gmail: "welcome-gmail" } as const;

/** How the process reaches Dex. */
export interface DexConnectionConfig {
  readonly serverAddress: string;
  readonly flowServiceTls: FlowServiceTlsOptions | undefined;
  readonly credential: Credential | undefined;
  readonly blobCacheDirectory: string;
}

/** Everything the signup agent reads from its environment. */
export interface SignupAgentConfig {
  readonly dex: DexConnectionConfig;
  readonly reviewApiUrl: string;
  readonly reviewApiKey: string;
  readonly slackChannelId: string;
  readonly reviewerSlackIds: ReadonlySet<string>;
  readonly harness: AgentHarness;
  readonly piModel: string;
  readonly anthropicApiKey: string | undefined;
  readonly githubToken: string | undefined;
  readonly watchIntervalMs: number;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required; see .env.example`);
  }
  return value;
}

function optional(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = environment[name]?.trim();
  return value ? value : undefined;
}

/** Reads how to reach Dex: local `dexcli dev` by default, or a remote server with TLS and an API key. */
export function loadDexConnectionConfig(environment: NodeJS.ProcessEnv = process.env): DexConnectionConfig {
  const apiKey = optional(environment, "DEX_API_KEY");
  const isTls = ["1", "true", "yes"].includes((optional(environment, "DEX_TLS") ?? "").toLowerCase());
  return {
    serverAddress: optional(environment, "DEX_FLOW_SERVICE_ADDRESS") ?? "127.0.0.1:8801",
    flowServiceTls: isTls ? {} : undefined,
    credential:
      apiKey === undefined
        ? undefined
        : new ApiKeyCredential({
            tokenUrl: required(environment, "DEX_TOKEN_URL"),
            serverId: required(environment, "DEX_SERVER_ID"),
            apiKey,
          }),
    blobCacheDirectory: optional(environment, "DEX_BLOB_CACHE_DIR") ?? ".dex-blob-cache",
  };
}

/** Reads the whole configuration; throws with the name of the first missing variable. */
export function loadSignupAgentConfig(environment: NodeJS.ProcessEnv = process.env): SignupAgentConfig {
  const reviewerSlackIds = new Set(
    required(environment, "SIGNUP_REVIEWER_SLACK_IDS")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id !== ""),
  );
  const watchSeconds = Number(optional(environment, "SIGNUP_WATCH_INTERVAL_SECONDS") ?? "30");
  if (!Number.isFinite(watchSeconds) || watchSeconds < 5) {
    throw new Error("SIGNUP_WATCH_INTERVAL_SECONDS must be a number of at least 5");
  }
  return {
    dex: loadDexConnectionConfig(environment),
    reviewApiUrl: required(environment, "REVIEW_API_URL"),
    reviewApiKey: required(environment, "REVIEW_API_KEY"),
    slackChannelId: required(environment, "SLACK_REVIEW_CHANNEL"),
    reviewerSlackIds,
    harness: parseAgentHarness(optional(environment, "SIGNUP_AGENT_HARNESS") ?? AgentHarness.pi),
    piModel: optional(environment, "SIGNUP_AGENT_PI_MODEL") ?? defaultPiModelName,
    anthropicApiKey: optional(environment, "ANTHROPIC_API_KEY"),
    githubToken: optional(environment, "GITHUB_TOKEN"),
    watchIntervalMs: watchSeconds * 1_000,
  };
}
