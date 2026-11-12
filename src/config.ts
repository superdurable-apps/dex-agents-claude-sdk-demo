// Process configuration from environment variables (`npm start` loads `.env`). Secrets are never logged.

import { ApiKeyCredential } from "@superdurable/dex";

export interface SignupAgentConfig {
  /** Dex Client and Worker options: local `dexcli dev` by default, or a remote server with TLS and an API key. */
  readonly dex: {
    readonly options: { serverAddress: string; flowServiceTls?: object; credential?: ApiKeyCredential };
    readonly blobCacheDirectory: string;
  };
  readonly reviewApiUrl: string;
  readonly reviewApiKey: string;
  readonly slackChannelId: string;
  readonly reviewerSlackIds: ReadonlySet<string>;
  readonly harness: string;
  readonly piModel: string;
  readonly claudeModel: string;
  readonly githubToken: string | undefined;
  readonly watchIntervalMs: number;
}

export function loadSignupAgentConfig(environment: NodeJS.ProcessEnv = process.env): SignupAgentConfig {
  const optional = (name: string): string | undefined => environment[name]?.trim() || undefined;
  const required = (name: string): string => optional(name) ?? (() => { throw new Error(`${name} is required; see .env.example`); })();
  const apiKey = optional("DEX_API_KEY");
  return {
    dex: {
      options: {
        serverAddress: optional("DEX_FLOW_SERVICE_ADDRESS") ?? "127.0.0.1:8801",
        ...(["1", "true"].includes(optional("DEX_TLS") ?? "") ? { flowServiceTls: {} } : {}),
        ...(apiKey === undefined
          ? {}
          : { credential: new ApiKeyCredential({ tokenUrl: required("DEX_TOKEN_URL"), serverId: required("DEX_SERVER_ID"), apiKey }) }),
      },
      blobCacheDirectory: optional("DEX_BLOB_CACHE_DIR") ?? ".dex-blob-cache",
    },
    reviewApiUrl: required("REVIEW_API_URL"),
    reviewApiKey: required("REVIEW_API_KEY"),
    slackChannelId: required("SLACK_REVIEW_CHANNEL"),
    reviewerSlackIds: new Set(required("SIGNUP_REVIEWER_SLACK_IDS").split(",").map((id) => id.trim()).filter(Boolean)),
    harness: optional("SIGNUP_AGENT_HARNESS") ?? "pi",
    piModel: optional("SIGNUP_AGENT_PI_MODEL") ?? "anthropic/claude-opus-5-5",
    claudeModel: optional("SIGNUP_AGENT_CLAUDE_MODEL") ?? "claude-opus-5-5",
    githubToken: optional("GITHUB_TOKEN"),
    watchIntervalMs: Number(optional("SIGNUP_WATCH_INTERVAL_SECONDS") ?? "30") * 1_000,
  };
}
