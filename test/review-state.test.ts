// A ledger record that meets a lock conflict is tried again; any other error, or a lasting conflict, is not.

import assert from "node:assert/strict";
import test from "node:test";

import { RpcLockConflictError } from "@superdurable/dex";

import { retryOnLockConflict } from "../src/review-state.js";

const conflict = () => new RpcLockConflictError(10 as never, "RPC_LOCK_CONFLICT" as never, "Effects is locked", "invokeRPC", "signup-review-a-ledger");

test("a record retries after a lock conflict and returns the later result", async () => {
  let calls = 0;
  const result = await retryOnLockConflict(async () => {
    calls += 1;
    if (calls < 3) {
      throw conflict();
    }
    return "recorded";
  });
  assert.equal(result, "recorded");
  assert.equal(calls, 3);
});

test("a lasting lock conflict fails after 4 tries", async () => {
  let calls = 0;
  await assert.rejects(
    retryOnLockConflict(async () => {
      calls += 1;
      throw conflict();
    }),
    RpcLockConflictError,
  );
  assert.equal(calls, 4);
});

test("any other error is not retried", async () => {
  let calls = 0;
  await assert.rejects(
    retryOnLockConflict(async () => {
      calls += 1;
      throw new Error("the review ledger holds its maximum");
    }),
    /maximum/,
  );
  assert.equal(calls, 1);
});
