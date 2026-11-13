// The review scenarios with the Claude Agent SDK harness: the real bundled Claude Code CLI, in a closed environment
// that reaches only a scripted Messages API.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClaudeSignupAgent } from "../src/claude-agent.js";
import { ScriptedMessagesApi } from "./support/scripted-messages-api.js";
import { registerSignupReviewScenarios } from "./support/signup-review-scenarios.js";

const stateDirectory = mkdtempSync(join(tmpdir(), "signup-agent-claude-"));
let messagesApi: ScriptedMessagesApi;

registerSignupReviewScenarios({
  harnessName: "Claude Agent SDK",
  createFlow: async (services) => {
    messagesApi = await ScriptedMessagesApi.start();
    mkdirSync(join(stateDirectory, "home"), { recursive: true });
    return createClaudeSignupAgent(services, {
      model: "claude-opus-5-5",
      cliEnvironment: {
        PATH: "/usr/bin:/bin",
        HOME: join(stateDirectory, "home"),
        CLAUDE_CONFIG_DIR: join(stateDirectory, "claude-config"),
        ANTHROPIC_BASE_URL: messagesApi.baseUrl,
        ANTHROPIC_API_KEY: "sk-ant-test-not-a-real-key",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        // A closed port: a request that bypasses ANTHROPIC_BASE_URL fails instead of reaching the network.
        HTTPS_PROXY: "http://127.0.0.1:9",
        HTTP_PROXY: "http://127.0.0.1:9",
        NO_PROXY: "127.0.0.1,localhost",
      },
    });
  },
  close: async () => {
    assert.deepEqual(messagesApi.unservedRequests, []);
    // The CLI offers the agent's own tools only: no Claude Code built-in tool, such as Bash or Read. The placeholder
    // stands in for a deferred call while the CLI resumes it; it runs nothing.
    const offered = [...messagesApi.offeredTools].filter((name) => name !== "DeferredToolPlaceholder").map((name) => name.split("__").at(-1)).sort();
    assert.deepEqual(offered, ["approve_account", "fetch_profile", "finish_review", "github_user", "post_draft", "post_review", "reject_account", "reply_in_thread", "send_welcome_email"]);
    await messagesApi.stop();
    rmSync(stateDirectory, { recursive: true, force: true });
  },
});
