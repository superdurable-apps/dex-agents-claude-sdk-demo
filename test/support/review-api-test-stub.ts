// TEST ONLY: an in-memory HTTP stand-in for the Dex Cloud ReviewAPI, following its contract, for local tests.
// The real ReviewAPI is part of Dex Cloud; never point the application at this stub outside the tests.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { Account, AccountStatus } from "../../src/review-api.js";

/** One decision request the stub received. */
export interface RecordedDecision {
  readonly operation: "approve" | "reject";
  readonly accountId: string;
  readonly requestId: string;
  readonly expectedRevision: number | string;
  readonly suppressApprovedMail?: boolean;
}

interface StoredAccount {
  account: Account;
  readonly appliedRequests: Map<string, Account>;
}

/** TEST ONLY. A ReviewAPI with accounts in memory: CAS on `expectedRevision` and idempotent `requestId`. */
export class ReviewApiTestStub {
  public readonly decisions: RecordedDecision[] = [];
  public readonly apiKey = "srk_test_not-a-real-secret";
  private readonly accounts = new Map<string, StoredAccount>();

  private constructor(private readonly server: Server) {}

  public static async start(): Promise<ReviewApiTestStub> {
    let stub: ReviewApiTestStub | undefined;
    const server = createServer((request, response) => {
      void stub!.answer(request, response);
    });
    stub = new ReviewApiTestStub(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return stub;
  }

  public get baseUrl(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  public async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Adds a pending sign-up. */
  public addPendingAccount(account: Omit<Account, "status" | "revision" | "registeredAt"> & Partial<Account>): Account {
    const stored: Account = { status: "pending_approval", revision: 1, registeredAt: new Date().toISOString(), ...account };
    this.accounts.set(stored.accountId, { account: stored, appliedRequests: new Map() });
    return stored;
  }

  /** Decides an account as an administrator on the Dex Cloud Users page would, which moves its revision. */
  public decideElsewhere(accountId: string, status: AccountStatus): void {
    const stored = this.accounts.get(accountId)!;
    stored.account = { ...stored.account, status, revision: Number(stored.account.revision) + 1 };
  }

  public accountOf(accountId: string): Account | undefined {
    return this.accounts.get(accountId)?.account;
  }

  private async answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request);
    if (request.headers.authorization !== `Bearer ${this.apiKey}`) {
      send(response, 401, { error: { code: "unauthenticated", message: "unauthenticated" } });
      return;
    }
    const operation = (request.url ?? "").replace(/^\/v1\/account-review\//, "");
    const input = (body === "" ? {} : JSON.parse(body)) as Record<string, unknown>;
    if (operation === "list-pending") {
      const accounts = [...this.accounts.values()]
        .map((stored) => stored.account)
        .filter((account) => account.status === "pending_approval")
        .sort((left, right) => left.registeredAt.localeCompare(right.registeredAt));
      send(response, 200, { accounts, nextPageToken: "" });
      return;
    }
    const stored = this.accounts.get(String(input.accountId));
    if (stored === undefined) {
      send(response, 404, { error: { code: "not_found", message: "no such account" } });
      return;
    }
    if (operation === "get") {
      send(response, 200, { account: stored.account });
      return;
    }
    if (operation !== "approve" && operation !== "reject") {
      send(response, 404, { error: { code: "not_found", message: "no such operation" } });
      return;
    }
    const decision: RecordedDecision = {
      operation,
      accountId: stored.account.accountId,
      requestId: String(input.requestId),
      expectedRevision: input.expectedRevision as number | string,
      ...(operation === "approve" ? { suppressApprovedMail: input.suppressApprovedMail === true } : {}),
    };
    this.decisions.push(decision);
    const applied = stored.appliedRequests.get(decision.requestId);
    if (applied !== undefined) {
      send(response, 200, { account: applied });
      return;
    }
    if (String(decision.expectedRevision) !== String(stored.account.revision) || stored.account.status !== "pending_approval") {
      send(response, 409, { error: { code: "revision_conflict", message: "the account changed" }, account: stored.account });
      return;
    }
    stored.account = {
      ...stored.account,
      status: operation === "approve" ? "active" : "rejected",
      revision: Number(stored.account.revision) + 1,
    };
    stored.appliedRequests.set(decision.requestId, stored.account);
    send(response, 200, { account: stored.account });
  }
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
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
