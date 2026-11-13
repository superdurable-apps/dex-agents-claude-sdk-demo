// Client of the Dex Cloud account review API (ReviewAPI): list pending sign-ups, read one, approve or reject it.

import { z } from "zod";

const AccountSchema = z.object({
  accountId: z.string().min(1),
  email: z.string().min(1),
  // Absent or null until the sign-up form collects them.
  displayName: z.string().nullish(),
  profileUrl: z.string().nullish(),
  signupMethod: z.string().nullish(),
  status: z.enum(["pending_verification", "pending_approval", "active", "rejected", "expired", "disabled"]),
  registeredAt: z.string().min(1),
  emailVerifiedAt: z.string().nullish(),
  // Opaque: sent back unchanged as expectedRevision.
  revision: z.union([z.number(), z.string()]),
});
export type Account = z.infer<typeof AccountSchema>;

export const ReviewApiErrorCode = [
  "unauthenticated",
  "invalid_argument",
  "not_found",
  "revision_conflict",
  "failed_precondition",
  "resource_exhausted",
  "unavailable",
  "internal",
] as const;
export type ReviewApiErrorCode = (typeof ReviewApiErrorCode)[number];

/** A decision may wait up to 10 seconds for its account's run and the server answers within 30 seconds. */
const decisionTimeoutMs = 30_000;

/** A failed ReviewAPI call; `revision_conflict` carries the current account. */
export class ReviewApiError extends Error {
  public constructor(
    public readonly code: ReviewApiErrorCode | "unexpected",
    public readonly httpStatus: number,
    message: string,
    public readonly currentAccount?: Account,
  ) {
    super(message);
    this.name = "ReviewApiError";
  }
}

/** Calls the ReviewAPI: one POST with a JSON body per operation. The key is never logged or stored in Flow state. */
export class ReviewApiClient {
  private readonly baseUrl: string;

  public constructor(private readonly settings: { readonly baseUrl: string; readonly apiKey: string }) {
    const url = new URL(settings.baseUrl);
    if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      throw new TypeError("REVIEW_API_URL must use HTTPS");
    }
    this.baseUrl = settings.baseUrl.replace(/\/+$/, "");
  }

  /** Accounts waiting for approval, oldest registration first; `pageSize` is at most 100. */
  public async listPendingAccounts(pageSize: number, pageToken: string, signal?: AbortSignal) {
    const body = await this.post("list-pending", { pageSize, pageToken }, signal);
    const accounts: Account[] = [];
    // One malformed row is skipped and logged; it never hides the rest of the page.
    for (const row of Array.isArray(body.accounts) ? (body.accounts as unknown[]) : []) {
      const parsed = AccountSchema.safeParse(row);
      if (parsed.success) {
        accounts.push(parsed.data);
      } else {
        console.warn(`ReviewAPI list-pending: skipped a malformed account: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
      }
    }
    return { accounts, nextPageToken: String(body.nextPageToken ?? "") };
  }

  public async getAccount(accountId: string, signal?: AbortSignal): Promise<Account> {
    return AccountSchema.parse((await this.post("get", { accountId }, signal)).account);
  }

  /** A repeated `requestId` answers its applied result; a moved revision fails with `revision_conflict`. */
  public async approveAccount(
    request: { accountId: string; requestId: string; expectedRevision: number | string; suppressApprovedMail: boolean },
    signal?: AbortSignal,
  ): Promise<Account> {
    return AccountSchema.parse((await this.post("approve", request, signal, decisionTimeoutMs)).account);
  }

  public async rejectAccount(request: { accountId: string; requestId: string; expectedRevision: number | string }, signal?: AbortSignal): Promise<Account> {
    return AccountSchema.parse((await this.post("reject", request, signal, decisionTimeoutMs)).account);
  }

  private async post(operation: string, payload: object, signal?: AbortSignal, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetch(`${this.baseUrl}/v1/account-review/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.settings.apiKey}` },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.ok) {
      return body;
    }
    const error = (body.error ?? {}) as { code?: unknown; message?: unknown };
    const code = ReviewApiErrorCode.find((known) => known === error.code) ?? "unexpected";
    const message = typeof error.message === "string" ? error.message.slice(0, 500) : `HTTP ${response.status}`;
    const current = code === "revision_conflict" ? AccountSchema.safeParse(body.account) : undefined;
    throw new ReviewApiError(code, response.status, `ReviewAPI ${operation}: ${message}`, current?.success ? current.data : undefined);
  }
}
