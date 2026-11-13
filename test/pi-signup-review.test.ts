// The review scenarios with the pi harness, on Dex's built-in agent loop with a scripted model client.

import { ScriptedModelClient } from "@superdurable/dex-agents/testing";

import { createPiSignupAgent } from "../src/pi-agent.js";
import { decideNextStep } from "./support/scripted-signup-agent.js";
import { registerSignupReviewScenarios } from "./support/signup-review-scenarios.js";

const scriptedModel = new ScriptedModelClient((request) => {
  const seen = ScriptedModelClient.toolResults(request).map((result) => ({ name: result.toolName, output: result.output }));
  const step = decideNextStep(ScriptedModelClient.userTexts(request), seen);
  if (step.kind === "fail") {
    throw new Error("scripted model failure");
  }
  return step.kind === "answer" ? { text: step.text } : { toolCalls: step.calls.map((call) => ({ toolName: call.name, arguments: call.arguments })) };
});

registerSignupReviewScenarios({ harnessName: "pi", createFlow: (services) => createPiSignupAgent(services, scriptedModel) });
