// The reviewers' replies: the Slack connector's threadReplyCreated Trigger delivers each reply of a listed reviewer in
// a review thread to that review's agent session, through the session Flow's send_user_message RPC. No other Flow.

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  defaultTriggerLogger,
  logTriggerRecord,
  newDexRPCTriggerTarget,
  type TriggerEvent,
  type TriggerLogger,
  type TriggerTarget,
} from "@superdurable/connectors-sdk";
import { decodeTriggerConfiguration, newDurableTriggerTarget, parseTriggerPayloadJSON, type LoadedProject } from "@superdurable/connectors-sdk/projectconfig";
import {
  ConnectorID,
  MessageEventSchema,
  ThreadReplyCreatedTriggerConfigurationSchema,
  ThreadReplyCreatedTriggerDefinition,
  newMessageTriggerRunner,
  newProjectConnection,
  newProjectMessageTriggerRunner,
  relayedTriggerPath,
  type MessageEvent,
  type MessageTriggerRunner,
  type SlackClientOptions,
} from "@superdurable/connector-slack";
import type { Client } from "@superdurable/dex";

import { reviewSessionId, type ReviewSessionFlow, type ReviewSessions } from "./review-state.js";

/** The Slack connection the review posts, replies and Trigger use. */
export const reviewSlackConnection = "review-slack";
/** The threadReplyCreated binding of that connection. */
export const reviewReplyBinding = "signup-review-reply";
const replyTriggerKey = {
  connectorId: ConnectorID,
  connectionName: reviewSlackConnection,
  triggerName: ThreadReplyCreatedTriggerDefinition.trigger.triggerName,
  bindingName: reviewReplyBinding,
};

/** The review channel and the Slack members whose replies count. */
export interface ReviewChannel {
  readonly channelId: string;
  readonly reviewerIds: ReadonlySet<string>;
}

/**
 * The review channel and reviewers of a hosted Project: the configuration of the `signup-review-reply` binding, which
 * the user fills in Studio Setup. It is the only source of both there.
 */
export function reviewChannelOf(project: LoadedProject): ReviewChannel {
  const configuration = decodeTriggerConfiguration(project.configuration, replyTriggerKey, ThreadReplyCreatedTriggerConfigurationSchema);
  return { channelId: configuration.channelId, reviewerIds: new Set(configuration.threadReplyMatcher?.posterUserIds ?? []) };
}

/** The message a reply becomes in the session: `[slack <ts>] <@user>: <text>`. */
export const reviewReplyText = (event: TriggerEvent<MessageEvent>): string => `[slack ${event.payload.timestamp}] <@${event.payload.userId}>: ${event.payload.text.trim()}`;

export interface ReviewReplyParts {
  readonly client: Client;
  readonly sessionFlow: ReviewSessionFlow;
  readonly sessions: ReviewSessions;
  readonly channel: ReviewChannel;
  readonly logger?: TriggerLogger;
  /**
   * A reply in an unknown thread whose root is younger than this is retried rather than dropped: its review post may
   * have gone out before post_review's result was stored. 2 minutes by default.
   */
  readonly recentThreadMs?: number;
}

/**
 * The target of the reply binding. A reply of a listed reviewer, in the review channel, in a thread of a running
 * review, goes to that review's session; anything else is consumed without a delivery. The Slack connector already
 * drops bot messages (any app's, this one's included), edits and other subtypes.
 *
 * The thread decides the session, and Trigger routing is synchronous, so this target looks the thread up first (see
 * {@link ReviewSessions.accountOfThread}) and then hands the event to a Dex RPC target bound to that session. A
 * failed lookup throws and the event stays in the inbox for a retry; an event for a closed session is undeliverable
 * and consumed by the RPC target.
 */
export function createReviewReplyTarget(parts: ReviewReplyParts): TriggerTarget<MessageEvent> {
  const logger = parts.logger ?? defaultTriggerLogger;
  const recentThreadMs = parts.recentThreadMs ?? 2 * 60_000;
  // Deterministic and side-effect free, as a Trigger filter must be: the binding's own matcher, checked again.
  const isReviewerReply = (event: TriggerEvent<MessageEvent>): boolean => {
    const message = event.payload;
    return message.channelId === parts.channel.channelId && parts.channel.reviewerIds.has(message.userId) && message.threadTimestamp !== "" && message.threadTimestamp !== message.timestamp;
  };
  const deliverTo = (sessionId: string) =>
    newDexRPCTriggerTarget(parts.client, parts.sessionFlow.sendUserMessage, isReviewerReply, () => sessionId, (event) => ({ text: reviewReplyText(event) }), { logger });
  return {
    async handleTrigger(context, event) {
      if (!isReviewerReply(event)) {
        // Logs the skip as filtered.
        return deliverTo("").handleTrigger(context, event);
      }
      const threadTs = event.payload.threadTimestamp;
      const accountId = await parts.sessions.accountOfThread(threadTs, Date.now());
      if (accountId === undefined) {
        if (Date.now() - Number(threadTs.split(".")[0]) * 1_000 < recentThreadMs) {
          throw new Error(`thread ${threadTs} is not a known review thread yet`);
        }
        logTriggerRecord(logger, context, "info", "trigger event skipped: not a running review's thread", { event_id: event.id, thread_ts: threadTs });
        return;
      }
      return deliverTo(reviewSessionId(accountId)).handleTrigger(context, event);
    },
  };
}

/**
 * The runner of the reply binding on the `review-slack` connection; both run modes share the target.
 * - `project`: a hosted Project. The binding's configuration comes from the Project, and the shared connection has no
 *   app token, so the runner receives the events the platform relays: serve {@link serveRelayedReplies}.
 * - a {@link ReviewChannel}: a local `connections.json`, configured from the environment. The connection's credential
 *   carries an `app_token`, so the runner uses Slack Socket Mode. Its events wait in the same durable inbox, under
 *   `trigger-inboxes/` beside `connections.json`, so an event Slack saw acknowledged is not lost in a crash.
 */
export function createReviewReplyRunner(
  project: LoadedProject,
  configuration: "project" | ReviewChannel,
  target: TriggerTarget<MessageEvent>,
  slackOptions: SlackClientOptions = {},
): MessageTriggerRunner {
  if (configuration === "project") {
    return newProjectMessageTriggerRunner(project, reviewSlackConnection, { threadReplyCreatedRoutes: [{ bindingName: reviewReplyBinding, target }] }, slackOptions);
  }
  const durable = newDurableTriggerTarget(project.triggerInbox(replyTriggerKey), replyTriggerKey, target, {
    logger: slackOptions.logger ?? defaultTriggerLogger,
    decodePayload: (_payloadJSON, payloadBytes) => MessageEventSchema.parse(parseTriggerPayloadJSON(payloadBytes)),
  });
  return newMessageTriggerRunner({
    connection: newProjectConnection(project, reviewSlackConnection, slackOptions),
    threadReplyCreatedRoutes: [
      {
        bindingName: reviewReplyBinding,
        configuration: { channelId: configuration.channelId, threadReplyMatcher: { posterUserIds: [...configuration.reviewerIds] } },
        target: durable,
      },
    ],
  });
}

/** Serves the relayed Slack events at the connection's relay path; answers false for any other path. */
export function serveRelayedReplies(runner: MessageTriggerRunner, request: IncomingMessage, response: ServerResponse): boolean {
  if (request.url?.split("?")[0] !== relayedTriggerPath(reviewSlackConnection)) {
    return false;
  }
  void runner.serveHTTP(request, response);
  return true;
}
