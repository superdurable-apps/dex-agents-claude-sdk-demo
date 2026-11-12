// Connector calls from the review Flow's own Steps, with the connector's identity, retry and fence rules.

import {
  createCall,
  runMutation,
  runQuery,
  throwDexRetry,
  type ConnectionRef,
  type Mutation,
  type MutationResult,
  type Query,
  type QueryResult,
  type StepDefaults,
} from "@superdurable/connectors-sdk";
import type { AsyncContext, StepOptions } from "@superdurable/dex";

/**
 * Runs one query. A retry the connector asks for, such as a Slack 429, becomes a Dex retry of the Step attempt.
 * A query has no fence, so a Step may run several queries and record its own heartbeats.
 */
export async function runConnectorQuery<Input, Output>(
  context: AsyncContext,
  connection: ConnectionRef,
  operation: Query<Input, Output>,
  input: Input,
): Promise<QueryResult<Output>> {
  const call = createCall(context, connection, operation.definition().operation);
  try {
    return await runQuery(operation, call, input);
  } catch (error: unknown) {
    throwDexRetry(error);
  }
}

/**
 * Runs one mutation under the connector's stable call identity, which Dex keeps across the Step's retries.
 * The Slack and Gmail connectors fence the dispatch with the Step's heartbeat checkpoint, so a Step that runs a
 * mutation runs exactly one and records no heartbeat of its own.
 */
export async function runConnectorMutation<Input, Output>(
  context: AsyncContext,
  connection: ConnectionRef,
  operation: Mutation<Input, Output>,
  input: Input,
): Promise<MutationResult<Output>> {
  const call = createCall(context, connection, operation.definition().operation);
  try {
    return await runMutation(operation, call, input);
  } catch (error: unknown) {
    throwDexRetry(error);
  }
}

/** The Step options a connector operation declares, such as synchronous durability, its timeout and retry policy. */
export function connectorStepOptions(defaults: StepDefaults, overrides: StepOptions): StepOptions {
  return {
    ...(defaults.executeMethodTimeoutMs ? { executeMethodTimeoutMs: defaults.executeMethodTimeoutMs } : {}),
    ...(defaults.heartbeatTimeoutMs ? { heartbeatTimeoutMs: defaults.heartbeatTimeoutMs } : {}),
    ...(defaults.executeRetry ? { executeRetry: defaults.executeRetry } : {}),
    executeDurability: defaults.executeDurability === "async" ? "async" : "sync",
    ...overrides,
  };
}
