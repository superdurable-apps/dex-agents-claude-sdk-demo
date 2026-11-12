// Wires one Registry, BlobCache, Worker and Client for the review Flow and the agent session Flows.

import { Client, Registry, Worker, openBlobCache, type Flow } from "@superdurable/dex";

import type { DexConnectionConfig } from "./config.js";
import { ClientHolder, SignupReviewFlow, type SignupReviewDependencies } from "./signup-review/signup-review-flow.js";

/** A running application: its Flow, Client and Worker. */
export interface SignupApplication {
  readonly signupReviewFlow: SignupReviewFlow;
  readonly client: Client;
  readonly worker: Worker;
  /** Closes the Worker, then the Client, then the BlobCache. Call it after the watcher stopped. */
  stop(): Promise<void>;
}

/**
 * Starts the Worker and the Client. The review Flow's Steps use the same Client to call the agent sessions.
 * @param dependencies - Everything the review Flow needs except the Client, which this function creates.
 */
export async function startSignupApplication(
  dex: DexConnectionConfig,
  dependencies: Omit<SignupReviewDependencies, "clients">,
): Promise<SignupApplication> {
  const clients = new ClientHolder();
  const signupReviewFlow = new SignupReviewFlow({ ...dependencies, clients });
  const flows: Flow<any>[] = [signupReviewFlow, ...dependencies.agentSessionFlows.values()];
  const registry = new Registry(flows);
  const blobCache = openBlobCache({ directory: dex.blobCacheDirectory, maxBytes: 256 * 1024 * 1024 });
  const connection = {
    serverAddress: dex.serverAddress,
    ...(dex.flowServiceTls === undefined ? {} : { flowServiceTls: dex.flowServiceTls }),
    ...(dex.credential === undefined ? {} : { credential: dex.credential }),
  };
  const client = new Client(registry, blobCache, connection);
  clients.set(client);
  const worker = new Worker(registry, blobCache, connection);
  try {
    await worker.start();
    await worker.waitPullRegistered({ timeoutMs: 30_000 });
  } catch (error: unknown) {
    await worker.close();
    await client.close();
    blobCache.close();
    throw error;
  }
  return {
    signupReviewFlow,
    client,
    worker,
    async stop() {
      await worker.close();
      await client.close();
      blobCache.close();
    },
  };
}
