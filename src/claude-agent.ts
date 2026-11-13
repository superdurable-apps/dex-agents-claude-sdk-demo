// The Claude Agent SDK harness: the Claude Code CLI runs the session's turns; Dex runs each write in its own Step.
// The read tools run inside the CLI's turn segment; the guarded writes leave the segment one at a time.

import { tool } from "@anthropic-ai/claude-agent-sdk";
import { ToolExecutionError } from "@superdurable/dex-agents";
import { createClaudeAgentSessionFlow, currentDeferredToolExecution } from "@superdurable/dex-agents-claude-agent-sdk";

import type { ReviewSessionFlow } from "./review-state.js";
import { createSignupConnectorTools, createSignupTools, runSignupTool, signupAgentPrompt, type SignupServices } from "./signup-agent.js";

export const claudeHarnessLabel = "Claude Agent SDK (Claude Code CLI)";

/**
 * The whole environment of the Claude Code CLI; no other secret of the Worker reaches it. With `login` the CLI uses
 * the Claude Code login stored on this machine, such as a Claude subscription; with `api-key`, `ANTHROPIC_API_KEY`.
 */
export function claudeCliEnvironment(authentication: string, environment: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const names = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"];
  names.push(...(authentication === "api-key" ? ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"] : ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"]));
  return Object.fromEntries(names.filter((name) => environment[name]).map((name) => [name, environment[name]!]));
}

export function createClaudeSignupAgent(
  services: SignupServices,
  settings: { model: string; cliEnvironment: Record<string, string>; cliPath?: string },
): ReviewSessionFlow {
  const tools = createSignupTools(services);
  return createClaudeAgentSessionFlow(
    {
      options: {
        model: settings.model,
        systemPrompt: signupAgentPrompt,
        // No Claude Code built-in tools and no settings files: the agent has only its own tools.
        tools: [],
        settingSources: [],
        env: { ...settings.cliEnvironment, DISABLE_AUTOUPDATER: "1" },
        ...(settings.cliPath === undefined ? {} : { pathToClaudeCodeExecutable: settings.cliPath }),
      },
      customTools: tools.map((signupTool) =>
        tool(signupTool.name, signupTool.description, signupTool.schema.shape, async (args, extra) => {
          // A write runs in its own tool Step, which names the session; a read runs inside the CLI without one.
          const signal = (extra as { signal?: AbortSignal }).signal ?? new AbortController().signal;
          try {
            return { content: [{ type: "text", text: await runSignupTool(signupTool, args, currentDeferredToolExecution()?.flowId, signal) }] };
          } catch (error: unknown) {
            if (error instanceof ToolExecutionError) {
              return { content: [{ type: "text", text: error.message }], isError: true };
            }
            throw error;
          }
        }),
      ),
      toolPolicies: Object.fromEntries(tools.map((signupTool) => [signupTool.name, { effect: signupTool.effect, requiresApproval: false }])),
      toolSources: [createSignupConnectorTools(services)],
    },
    "SignupReviewClaudeAgentFlow",
  );
}
