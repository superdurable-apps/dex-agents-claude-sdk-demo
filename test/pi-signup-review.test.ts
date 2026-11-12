// The review scenarios with the pi harness: Dex's built-in agent loop with a scripted model client.

import { ScriptedModelClient } from "@superdurable/dex-agents/testing";

import { createPiSignupAgentFlow } from "../src/agent/pi-signup-agent.js";
import { AgentHarness } from "../src/signup-review/signup-review-values.js";
import { decideSignupReply } from "./support/signup-agent-script.js";
import { registerSignupReviewScenarios } from "./support/signup-review-scenarios.js";

const scriptedModel = new ScriptedModelClient((request) => {
  const toolNames = ScriptedModelClient.toolResults(request).map((result) => result.toolName);
  const reply = decideSignupReply(ScriptedModelClient.userTexts(request), toolNames);
  return reply.kind === "answer" ? { text: reply.text } : { toolCalls: [{ toolName: reply.toolName, arguments: reply.arguments }] };
});

registerSignupReviewScenarios({
  harnessName: "pi",
  harness: AgentHarness.pi,
  createAgentFlow: (tools) => createPiSignupAgentFlow(tools, scriptedModel),
});
