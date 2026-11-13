// TEST ONLY: a local Anthropic Messages API that answers from the scripted agent, so the real Claude Code CLI runs
// without a model key. Point ANTHROPIC_BASE_URL at it. Adapted from the Dex agent harness examples.

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { decideNextStep, type SeenResult } from "./scripted-signup-agent.js";

type JsonObject = Record<string, unknown>;
type ContentBlock = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: JsonObject };

/** Text the CLI adds when it resumes a deferred tool call; it is not a user command. */
const resumePromptText = "Continue from where you left off.";

export class ScriptedMessagesApi {
  public readonly unservedRequests: string[] = [];
  /** Every tool name a model request offered, as the CLI named it. */
  public readonly offeredTools = new Set<string>();

  private constructor(private readonly server: Server) {}

  public static async start(): Promise<ScriptedMessagesApi> {
    let api: ScriptedMessagesApi | undefined;
    const server = createServer((request, response) => void api!.answer(request, response));
    api = new ScriptedMessagesApi(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return api;
  }

  public get baseUrl(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  public async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request);
    const path = (request.url ?? "").split("?")[0] ?? "";
    if (request.method === "POST" && path.endsWith("/v1/messages/count_tokens")) {
      sendJson(response, { input_tokens: 10 });
      return;
    }
    if (request.method !== "POST" || !path.endsWith("/v1/messages")) {
      this.unservedRequests.push(`${request.method ?? "?"} ${path}`);
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: path } }));
      return;
    }
    const payload = JSON.parse(body) as JsonObject;
    const toolNames = ((payload.tools as JsonObject[] | undefined) ?? []).map((tool) => String(tool.name));
    toolNames.forEach((name) => this.offeredTools.add(name));
    const blocks = reply((payload.messages as JsonObject[] | undefined) ?? [], toolNames);
    if (blocks === "fail") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "scripted model failure" } }));
      return;
    }
    const model = String(payload.model ?? "claude-scripted");
    if (payload.stream === true) {
      stream(response, model, blocks);
    } else {
      sendJson(response, message(model, blocks, true));
    }
  }
}

function reply(messages: readonly JsonObject[], toolNames: readonly string[]): ContentBlock[] | "fail" {
  let commandIndex = -1;
  const userTexts: string[] = [];
  messages.forEach((entry, index) => {
    if (entry.role !== "user") {
      return;
    }
    const texts = blocksOf(entry)
      .filter((block) => block.type === "text")
      .map((block) => stripReminders(String(block.text)))
      .filter((text) => text !== "" && text !== resumePromptText);
    if (texts.length > 0) {
      commandIndex = index;
      userTexts.push(...texts);
    }
  });
  if (commandIndex < 0) {
    return [{ type: "text", text: "ok" }];
  }
  const names = new Map<string, string>();
  const seen: SeenResult[] = [];
  for (const block of messages.slice(commandIndex + 1).flatMap(blocksOf)) {
    if (block.type === "tool_use") {
      names.set(String(block.id), bare(String(block.name)));
    } else if (block.type === "tool_result" && names.has(String(block.tool_use_id))) {
      seen.push({ name: names.get(String(block.tool_use_id))!, output: resultText(block.content) });
    }
  }
  const step = decideNextStep(userTexts, seen);
  if (step.kind === "fail") {
    return "fail";
  }
  if (step.kind === "answer") {
    return [{ type: "text", text: step.text }];
  }
  // The CLI offers custom and source tools as mcp__<server>__<tool>; several calls become several tool_use blocks.
  return step.calls.map((call) => ({
    type: "tool_use",
    id: `toolu_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
    name: toolNames.find((candidate) => bare(candidate) === call.name) ?? call.name,
    input: { ...call.arguments },
  }));
}

function stream(response: ServerResponse, model: string, blocks: readonly ContentBlock[]): void {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (event: string, data: JsonObject) => response.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  send("message_start", { message: message(model, [], false) });
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      send("content_block_start", { index, content_block: { type: "text", text: "" } });
      send("content_block_delta", { index, delta: { type: "text_delta", text: block.text } });
    } else {
      send("content_block_start", { index, content_block: { ...block, input: {} } });
      send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    }
    send("content_block_stop", { index });
  });
  send("message_delta", { delta: { stop_reason: stopReason(blocks), stop_sequence: null }, usage: { output_tokens: 5 } });
  send("message_stop", {});
  response.end();
}

function message(model: string, blocks: readonly ContentBlock[], isComplete: boolean): JsonObject {
  return {
    id: `msg_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
    type: "message",
    role: "assistant",
    model,
    content: blocks,
    stop_reason: isComplete ? stopReason(blocks) : null,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: isComplete ? 5 : 1 },
  };
}

const stopReason = (blocks: readonly ContentBlock[]) => (blocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn");
const bare = (name: string) => name.split("__").at(-1) ?? name;

function blocksOf(entry: JsonObject): JsonObject[] {
  const content = entry.content;
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return Array.isArray(content) ? content.filter((block): block is JsonObject => typeof block === "object" && block !== null) : [];
}

function resultText(content: unknown): string {
  if (typeof content === "string") {
    return stripReminders(content);
  }
  return Array.isArray(content) ? stripReminders(content.map((block: JsonObject) => (block.type === "text" ? String(block.text) : "")).join("\n")) : "";
}

/** The CLI adds `<system-reminder>` blocks to prompts and tool results; they are not part of the script. */
const stripReminders = (text: string) => text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();

function sendJson(response: ServerResponse, payload: JsonObject): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}
