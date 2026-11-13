// TEST ONLY: an in-memory HTTP stand-in for the Dex Cloud ReviewAPI, following its contract, for local tests.
// The real ReviewAPI is part of Dex Cloud; never point the application at this stub outside the tests.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { Account } from "../../src/review-api.js";

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
  /** The last decision applied: its fingerprint over every member, and the account it left. */
  lastDecision?: { readonly fingerprint: string; readonly account: Account };
}

/**
 * TEST ONLY. A ReviewAPI with accounts in memory, following docs/api/account-review-api.md: revisions start at 0;
 * `revision_conflict` for a moved revision; `failed_precondition` for an account that is not pending; a repeat with
 * the same members answers 200 only while it is still the account's last decision.
 */
export class ReviewApiTestStub {
  public readonly decisions: RecordedDecision[] = [];
  public readonly apiKey = "srk_test_not-a-real-secret";
  private readonly accounts = new Map<string, StoredAccount>();
  /** Operations whose next call is applied but answered with a 503, as a lost response would look. */
  private readonly failAfterApplying = new Set<string>();
  /** Operations whose next call is refused with `failed_precondition` and not applied. */
  private readonly refuseNextCall = new Set<string>();
  /** As the server does until it can leave the platform's approval mail out: refuse `suppressApprovedMail: true`. */
  public refusesSuppressedMail = false;
  /** Gets answered with a 503 before the next one succeeds. */
  public failingGets = 0;
  /** Milliseconds every get waits before it answers. */
  public getDelayMs = 0;

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
    const stored: Account = { status: "pending_approval", revision: 0, registeredAt: new Date().toISOString(), emailVerifiedAt: null, ...account };
    this.accounts.set(stored.accountId, { account: stored });
    return stored;
  }

  /** Decides an account as an administrator on the Dex Cloud Users page would, which moves its revision. */
  public decideElsewhere(accountId: string, status: Account["status"]): void {
    const stored = this.accounts.get(accountId)!;
    stored.account = { ...stored.account, status, revision: Number(stored.account.revision) + 1 };
    delete stored.lastDecision;
  }

  /** Applies the next `operation` call, then answers 503 instead of the result. */
  public failNextResponse(operation: "approve" | "reject"): void {
    this.failAfterApplying.add(operation);
  }

  /** Refuses the next `operation` call with `failed_precondition`, applying nothing. */
  public refuseNext(operation: "approve" | "reject"): void {
    this.refuseNextCall.add(operation);
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
      if (this.getDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.getDelayMs));
      }
      if (this.failingGets > 0) {
        this.failingGets -= 1;
        send(response, 503, { error: { code: "unavailable", message: "busy" } });
        return;
      }
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
    const fingerprint = JSON.stringify([operation, input.accountId, input.requestId, input.expectedRevision, input.suppressApprovedMail ?? false]);
    if (stored.lastDecision?.fingerprint === fingerprint) {
      send(response, 200, { account: stored.lastDecision.account });
      return;
    }
    if (this.refuseNextCall.delete(operation)) {
      send(response, 409, { error: { code: "failed_precondition", message: "the account is locked" } });
      return;
    }
    if (operation === "approve" && input.suppressApprovedMail === true && this.refusesSuppressedMail) {
      send(response, 409, { error: { code: "failed_precondition", message: "suppressApprovedMail is not supported yet" } });
      return;
    }
    if (String(decision.expectedRevision) !== String(stored.account.revision)) {
      send(response, 409, { error: { code: "revision_conflict", message: "the account changed" }, account: stored.account });
      return;
    }
    if (stored.account.status !== "pending_approval") {
      send(response, 409, { error: { code: "failed_precondition", message: `the account is ${stored.account.status}` } });
      return;
    }
    stored.account = { ...stored.account, status: operation === "approve" ? "active" : "rejected", revision: Number(stored.account.revision) + 1 };
    stored.lastDecision = { fingerprint, account: stored.account };
    if (this.failAfterApplying.delete(operation)) {
      send(response, 503, { error: { code: "unavailable", message: "lost answer" } });
      return;
    }
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
