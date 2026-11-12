// What a review session has done so far, read from its own Dex state, and the Slack thread it posted.
// The tools' guards and the Slack reply relay decide from these facts, never from what the model says.

import { createCall, runQuery } from "@superdurable/connectors-sdk";
import type { Connection as SlackConnection, Message as SlackMessage } from "@superdurable/connector-slack";
import type { AsyncContext, Client } from "@superdurable/dex";
import {
  readAgentSnapshot,
  type AgentFrameworkRunner,
  type AgentMessage,
  type AgentSessionFlow,
  type AgentSnapshot,
  type DeferredToolOutcome,
} from "@superdurable/dex-agents";

/** An agent session Flow of either harness. */
export type ReviewSessionFlow = AgentSessionFlow<AgentFrameworkRunner<DeferredToolOutcome>>;

/** The session ID, which is the FlowID, of the review of one account. */
export const reviewSessionId = (accountId: string): string => `signup-review-${accountId}`;
export const accountIdOf = (sessionId: string): string => sessionId.replace(/^signup-review-/, "");

/** The Dex Client and the session Flow, set once the process has built them. */
export const dex: { client?: Client; flow?: ReviewSessionFlow } = {};

export interface Draft {
  readonly subject: string;
  readonly body: string;
  /** Slack timestamp of the post that showed this draft. */
  readonly ts: string;
}

/** The facts of one review session. */
export interface ReviewState {
  readonly snapshot: AgentSnapshot;
  /** The review's Slack thread, once post_review succeeded. */
  readonly thread?: { readonly channel: string; readonly ts: string };
  /** Every posted draft, oldest first; the first is the one in the review post. */
  readonly drafts: readonly Draft[];
  readonly isApprovedHere: boolean;
  readonly isRejectedHere: boolean;
  /** Whether send_welcome_email ever got past its guard, whatever its outcome: it never runs twice. */
  readonly hasSendAttempt: boolean;
  readonly isFinished: boolean;
}

/** One tool call of the session: its arguments, its output when it succeeded, and whether it has a result yet. */
interface ToolCallFact {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly output: Record<string, unknown> | undefined;
  /** The result text, success or failure; undefined while the call runs. */
  readonly resultText: string | undefined;
}

const bareName = (name: string): string => name.split("__").at(-1) ?? name;

function parseObject(text: string | null | undefined): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text ?? "");
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every tool call, from the stored messages of finished turns and the active turn's call records. A failed call's
 * output is error text, so its parsed output is undefined; a call still running has no result.
 */
function toolCallsOf(messages: readonly AgentMessage[], snapshot: AgentSnapshot): ToolCallFact[] {
  const results = new Map(messages.filter((message) => message.role === "tool").map((message) => [message.toolCallId, message.toolOutput]));
  const facts = new Map<string, ToolCallFact>();
  for (const message of messages) {
    if (message.role === "assistant" && message.toolName !== null && message.toolCallId !== null) {
      facts.set(message.toolCallId, {
        id: message.toolCallId,
        name: bareName(message.toolName),
        arguments: parseObject(message.toolArguments) ?? {},
        output: parseObject(results.get(message.toolCallId)),
        resultText: results.get(message.toolCallId) ?? undefined,
      });
    }
  }
  for (const record of snapshot.toolCalls) {
    const isFinal = ["succeeded", "failed", "rejected", "outcome_unknown"].includes(record.status);
    facts.set(record.toolCallId, {
      id: record.toolCallId,
      name: bareName(record.toolName),
      arguments: parseObject(record.arguments) ?? {},
      output: record.status === "succeeded" ? parseObject(record.output) : undefined,
      resultText: isFinal ? (record.output ?? record.error ?? record.rejectionMessage ?? record.status) : facts.get(record.toolCallId)?.resultText,
    });
  }
  return [...facts.values()];
}

/** All of the session's messages; the snapshot holds the newest 200, older ones are paged in. */
async function allMessages(client: Client, flow: ReviewSessionFlow, sessionId: string, snapshot: AgentSnapshot): Promise<AgentMessage[]> {
  let messages = [...snapshot.messages];
  for (let page = 0; page < 20 && (messages[0]?.sequence ?? 1) > 1; page++) {
    const older = await client.invokeRPC(flow.listAgentMessages, sessionId, { beforeSequence: messages[0]!.sequence, limit: 200 });
    if (older.messages.length === 0) {
      break;
    }
    messages = [...older.messages, ...messages];
  }
  return messages;
}

/** Reads what the session has done: its thread, its drafts, and its decisions. */
export async function readReviewState(sessionId: string): Promise<ReviewState> {
  const { client, flow } = dex as Required<typeof dex>;
  const snapshot = await readAgentSnapshot(client, flow, sessionId);
  const calls = toolCallsOf(await allMessages(client, flow, sessionId, snapshot), snapshot);
  const succeeded = (name: string) => calls.filter((call) => call.name === name && call.output !== undefined);
  const review = succeeded("post_review")[0];
  const reviewMessage = review?.output?.message as { channelId?: string; timestamp?: string } | undefined;
  const drafts: Draft[] = [];
  if (review !== undefined && reviewMessage?.timestamp) {
    drafts.push({ subject: String(review.arguments.emailSubject), body: String(review.arguments.emailBody), ts: reviewMessage.timestamp });
  }
  for (const call of succeeded("post_draft")) {
    const message = call.output?.message as { timestamp?: string } | undefined;
    drafts.push({ subject: String(call.arguments.subject), body: String(call.arguments.body), ts: message?.timestamp ?? "" });
  }
  return {
    snapshot,
    ...(reviewMessage?.timestamp ? { thread: { channel: String(reviewMessage.channelId), ts: reviewMessage.timestamp } } : {}),
    drafts,
    isApprovedHere: succeeded("approve_account").some((call) => call.output?.status === "approved"),
    isRejectedHere: succeeded("reject_account").some((call) => call.output?.status === "rejected"),
    // A refusal (the guard, or the connector proving nothing was sent) is no attempt; anything else may have sent.
    hasSendAttempt: calls.some((call) => call.name === "send_welcome_email" && call.resultText !== undefined && !/refused:|not sent/.test(call.resultText)),
    isFinished: succeeded("finish_review").length > 0,
  };
}

/** Whether the session holds or queues a user message that starts with `marker`. */
export function hasUserMessage(snapshot: AgentSnapshot, marker: string): boolean {
  return (
    snapshot.messages.some((message) => message.role === "user" && (message.text ?? "").startsWith(marker)) ||
    (snapshot.queuedMessages ?? []).some((pending) => pending.message.text.startsWith(marker))
  );
}

/** Whether Slack timestamp `ts` is later than `other`, compared exactly (`<seconds>.<microseconds>`). */
export function isLater(ts: string, other: string): boolean {
  const exact = (value: string): bigint => {
    const [seconds = "0", fraction = ""] = value.split(".");
    return BigInt(seconds) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
  };
  return exact(ts) > exact(other);
}

/**
 * The reviewers' replies in a thread, oldest first: messages after the root post from members in `reviewerIds`.
 * Thread reads run outside any Dex Step (in a tool or in the relay); a query has no fence, so a fixed call identity
 * per session is enough.
 */
export async function readReviewerReplies(
  slack: SlackConnection,
  sessionId: string,
  thread: { readonly channel: string; readonly ts: string },
  reviewerIds: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<SlackMessage[]> {
  const operation = slack.operations.listThreadMessages();
  const context = { flowId: sessionId, runId: "", stepExecutionId: "read-review-thread", attempt: 1, cancellationSignal: signal, deadline: undefined };
  const call = createCall(context as unknown as AsyncContext, slack.reference, operation.definition().operation);
  const replies: SlackMessage[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const result = await runQuery(operation, call, { channelId: thread.channel, threadTimestamp: thread.ts, pageSize: 15, ...(cursor ? { cursor } : {}) });
    if (result.branch !== "read") {
      throw new Error(`reading the Slack thread ended ${result.branch}: ${result.failure?.message ?? ""}`);
    }
    for (const message of result.value.messages ?? []) {
      if (isLater(message.timestamp, thread.ts) && message.userId !== undefined && reviewerIds.has(message.userId)) {
        replies.push(message);
      }
    }
    cursor = result.value.nextCursor;
    if (!cursor) {
      break;
    }
  }
  return replies;
}
