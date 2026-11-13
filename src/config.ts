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
  /** `login` (the Claude Code login on this machine) or `api-key` (ANTHROPIC_API_KEY). */
  readonly claudeAuthentication: string;
  readonly claudeCliPath: string | undefined;
  readonly githubToken: string | undefined;
  readonly watchIntervalMs: number;
  /** Only sign-ups registered at or after this time are reviewed. */
  readonly reviewSince: Date;
  readonly threadPollIntervalMs: number;
  /** The Worker's execution slots: each open review's poller holds one while it polls. */
  readonly workerSlots: number;
}

/** SIGNUP_REVIEW_SINCE is required, so a first start never reviews the whole backlog of pending sign-ups. */
function reviewSince(value: string): Date {
  const since = new Date(value);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(since.getTime())) {
    throw new Error(`SIGNUP_REVIEW_SINCE must be an RFC 3339 time, such as ${new Date().toISOString()}`);
  }
  return since;
}

function positiveInteger(value: string, name: string, unit = "seconds"): number {
  if (!/^[1-9]\d{0,5}$/.test(value)) {
    throw new Error(`${name} must be a positive whole number of ${unit}`);
  }
  return Number(value);
}

export function loadSignupAgentConfig(environment: NodeJS.ProcessEnv = process.env): SignupAgentConfig {
  const optional = (name: string): string | undefined => environment[name]?.trim() || undefined;
  const required = (name: string): string => optional(name) ?? (() => { throw new Error(`${name} is required; see .env.example`); })();
  const apiKey = optional("DEX_API_KEY");
  const harness = optional("SIGNUP_AGENT_HARNESS") ?? "pi";
  if (harness !== "pi" && harness !== "claude-agent-sdk") {
    throw new Error("SIGNUP_AGENT_HARNESS must be pi or claude-agent-sdk");
  }
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
    reviewSince: reviewSince(required("SIGNUP_REVIEW_SINCE")),
    reviewApiKey: required("REVIEW_API_KEY"),
    slackChannelId: required("SLACK_REVIEW_CHANNEL"),
    reviewerSlackIds: new Set(required("SIGNUP_REVIEWER_SLACK_IDS").split(",").map((id) => id.trim()).filter(Boolean)),
    harness,
    piModel: optional("SIGNUP_AGENT_PI_MODEL") ?? "anthropic/claude-opus-5-5",
    claudeModel: optional("SIGNUP_AGENT_CLAUDE_MODEL") ?? "claude-opus-5-5",
    claudeAuthentication: optional("SIGNUP_AGENT_CLAUDE_AUTH") ?? "login",
    claudeCliPath: optional("SIGNUP_AGENT_CLAUDE_CLI"),
    githubToken: optional("GITHUB_TOKEN"),
    watchIntervalMs: positiveInteger(optional("SIGNUP_WATCH_INTERVAL_SECONDS") ?? "30", "SIGNUP_WATCH_INTERVAL_SECONDS") * 1_000,
    threadPollIntervalMs: positiveInteger(optional("SIGNUP_THREAD_POLL_SECONDS") ?? "60", "SIGNUP_THREAD_POLL_SECONDS") * 1_000,
    workerSlots: positiveInteger(optional("SIGNUP_WORKER_SLOTS") ?? "64", "SIGNUP_WORKER_SLOTS", "slots"),
  };
}
