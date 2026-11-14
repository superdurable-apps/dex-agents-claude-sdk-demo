// The reply target's routing, with a recording Dex Client and a scripted thread index: which replies reach which
// session, which are dropped, and which wait for a retry.

import assert from "node:assert/strict";
import test from "node:test";

import { newTriggerContext, type TriggerEvent, type TriggerLogAttributes } from "@superdurable/connectors-sdk";
import type { MessageEvent } from "@superdurable/connector-slack";
import type { Client } from "@superdurable/dex";

import { createReviewReplyTarget, reviewReplyText } from "../src/review-replies.js";
import type { ReviewSessionFlow, ReviewSessions } from "../src/review-state.js";

const nowTs = () => `${Math.floor(Date.now() / 1_000)}.000100`;
const reply = (threadTimestamp: string, extra: Partial<MessageEvent> = {}): TriggerEvent<MessageEvent> => ({
  id: `Ev-${threadTimestamp}-${extra.userId ?? "UREVIEWER1"}`,
  occurredAt: new Date(),
  payload: { teamId: "T1", channelId: "CREVIEWS01", timestamp: "1710000200.000200", threadTimestamp, userId: "UREVIEWER1", text: "  approve \n", ...extra },
});

function harness(threads: Record<string, string>) {
  const invoked: { flowId: string; input: unknown }[] = [];
  const records: { message: string; attributes: TriggerLogAttributes }[] = [];
  const lookups: string[] = [];
  const sendUserMessage = () => ({ output: true });
  const client = { invokeRPC: async (_method: unknown, flowId: string, input: unknown) => void invoked.push({ flowId, input }) } as unknown as Client;
  const sessions = {
    accountOfThread: async (threadTs: string) => {
      lookups.push(threadTs);
      return threads[threadTs];
    },
  } as unknown as ReviewSessions;
  const target = createReviewReplyTarget({
    client,
    sessionFlow: { sendUserMessage } as unknown as ReviewSessionFlow,
    sessions,
    channel: { channelId: "CREVIEWS01", reviewerIds: new Set(["UREVIEWER1"]) },
    logger: { isEnabled: () => true, log: (_level, message, attributes) => void records.push({ message, attributes }) },
  });
  return { target, invoked, records, lookups };
}

test("a reviewer's reply in a review thread goes to that review's session as [slack <ts>] <@user>: <text>", async () => {
  const { target, invoked } = harness({ "1710000100.000100": "acct1" });
  const event = reply("1710000100.000100");
  await target.handleTrigger(newTriggerContext(), event);
  assert.deepEqual(invoked, [{ flowId: "signup-review-acct1", input: { text: "[slack 1710000200.000200] <@UREVIEWER1>: approve" } }]);
  assert.equal(reviewReplyText(event), "[slack 1710000200.000200] <@UREVIEWER1>: approve");
});

test("a reply of someone else, in another channel, or at the top level is filtered without a lookup", async () => {
  const { target, invoked, lookups, records } = harness({ "1710000100.000100": "acct1" });
  await target.handleTrigger(newTriggerContext(), reply("1710000100.000100", { userId: "UBYSTANDER" }));
  await target.handleTrigger(newTriggerContext(), reply("1710000100.000100", { channelId: "COTHER0001" }));
  await target.handleTrigger(newTriggerContext(), reply("1710000200.000200"));
  assert.deepEqual(invoked, []);
  assert.deepEqual(lookups, []);
  assert.equal(records.filter((record) => record.message === "trigger event skipped: filtered").length, 3);
});

test("a reply in an old thread that is no running review's is dropped; in a recent one it waits for a retry", async () => {
  const { target, invoked, records } = harness({});
  await target.handleTrigger(newTriggerContext(), reply("1600000000.000100"));
  assert.equal(records.filter((record) => record.message === "trigger event skipped: not a running review's thread").length, 1);
  // A review post younger than two minutes may not be in its session's records yet: the event stays in the inbox.
  await assert.rejects(target.handleTrigger(newTriggerContext(), reply(nowTs())), /is not a known review thread yet/);
  assert.deepEqual(invoked, []);
});
