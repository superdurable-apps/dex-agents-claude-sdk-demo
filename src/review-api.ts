// Client of the Dex Cloud account review API (ReviewAPI): list pending sign-ups, read one, approve or reject it.

/** Account status values the ReviewAPI returns. */
export const AccountStatus = {
  pendingVerification: "pending_verification",
  pendingApproval: "pending_approval",
  active: "active",
  rejected: "rejected",
  expired: "expired",
  disabled: "disabled",
} as const;
export type AccountStatus = (typeof AccountStatus)[keyof typeof AccountStatus];

const accountStatuses: ReadonlySet<string> = new Set(Object.values(AccountStatus));

/** ReviewAPI error codes. */
export const ReviewApiErrorCode = {
  unauthenticated: "unauthenticated",
  invalidArgument: "invalid_argument",
  notFound: "not_found",
  revisionConflict: "revision_conflict",
  failedPrecondition: "failed_precondition",
  resourceExhausted: "resource_exhausted",
  unavailable: "unavailable",
  internal: "internal",
} as const;
export type ReviewApiErrorCode = (typeof ReviewApiErrorCode)[keyof typeof ReviewApiErrorCode];

/** One account as the ReviewAPI returns it. `revision` is opaque: it is sent back unchanged as `expectedRevision`. */
export interface Account {
  readonly accountId: string;
  readonly email: string;
  /** Absent until the sign-up form collects a name. */
  readonly displayName?: string;
  /** Absent until the sign-up form collects a profile link. */
  readonly profileUrl?: string;
  /** `password`, `google` or `github`; absent until the API reports it. */
  readonly signupMethod?: string;
  readonly status: AccountStatus;
  readonly registeredAt: string;
  readonly emailVerifiedAt?: string;
  readonly revision: number | string;
}

/** One page of pending accounts, oldest registration first. */
export interface PendingAccountsPage {
  readonly accounts: readonly Account[];
  readonly nextPageToken: string;
}

/** A failed ReviewAPI call with the API's error code. */
export class ReviewApiError extends Error {
  public constructor(
    public readonly code: ReviewApiErrorCode | "unexpected",
    public readonly httpStatus: number,
    message: string,
    /** The current account, sent with `revision_conflict`. */
    public readonly currentAccount?: Account,
  ) {
    super(message);
    this.name = "ReviewApiError";
  }
}

/** Decodes and checks one account; throws a TypeError for a malformed value. */
export function decodeAccount(value: unknown): Account {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("account must be an object");
  }
  const raw = value as Record<string, unknown>;
  const text = (name: string): string => {
    const field = raw[name];
    if (typeof field !== "string" || field === "") {
      throw new TypeError(`account.${name} must be a non-empty string`);
    }
    return field;
  };
  const optionalText = (name: string): string | undefined => {
    const field = raw[name];
    if (field === undefined || field === null || field === "") {
      return undefined;
    }
    if (typeof field !== "string") {
      throw new TypeError(`account.${name} must be a string`);
    }
    return field;
  };
  const status = text("status");
  if (!accountStatuses.has(status)) {
    throw new TypeError(`account.status ${status} is unknown`);
  }
  const revision = raw.revision;
  if (typeof revision !== "number" && typeof revision !== "string") {
    throw new TypeError("account.revision must be a number or a string");
  }
  const displayName = optionalText("displayName");
  const profileUrl = optionalText("profileUrl");
  const signupMethod = optionalText("signupMethod");
  const emailVerifiedAt = optionalText("emailVerifiedAt");
  return {
    accountId: text("accountId"),
    email: text("email"),
    ...(displayName === undefined ? {} : { displayName }),
    ...(profileUrl === undefined ? {} : { profileUrl }),
    ...(signupMethod === undefined ? {} : { signupMethod }),
    status: status as AccountStatus,
    registeredAt: text("registeredAt"),
    ...(emailVerifiedAt === undefined ? {} : { emailVerifiedAt }),
    revision,
  };
}

/** Connection settings of the ReviewAPI. The key is a secret: it is never logged or stored in Flow state. */
export interface ReviewApiSettings {
  /** Base URL, such as `https://review-api.example.com`; paths start with `/v1/account-review/`. */
  readonly baseUrl: string;
  /** Bearer key `srk_<id>_<secret>`. */
  readonly apiKey: string;
  /** Timeout of one call in milliseconds. */
  readonly requestTimeoutMs?: number;
}

const defaultRequestTimeoutMs = 10_000;

/** Calls the ReviewAPI. Every method is one POST with a JSON body. */
export class ReviewApiClient {
  private readonly baseUrl: string;

  public constructor(private readonly settings: ReviewApiSettings) {
    const url = new URL(settings.baseUrl);
    if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      throw new TypeError("REVIEW_API_URL must use HTTPS");
    }
    this.baseUrl = settings.baseUrl.replace(/\/+$/, "");
  }

  /** Lists accounts waiting for approval, oldest registration first. `pageSize` is at most 100. */
  public async listPendingAccounts(pageSize: number, pageToken: string, signal?: AbortSignal): Promise<PendingAccountsPage> {
    const body = await this.post("list-pending", { pageSize, pageToken }, signal);
    const accounts = Array.isArray(body.accounts) ? body.accounts.map(decodeAccount) : [];
    return { accounts, nextPageToken: typeof body.nextPageToken === "string" ? body.nextPageToken : "" };
  }

  /** Reads one account. */
  public async getAccount(accountId: string, signal?: AbortSignal): Promise<Account> {
    return decodeAccount((await this.post("get", { accountId }, signal)).account);
  }

  /**
   * Approves an account if its revision still matches. A repeated `requestId` is idempotent.
   * @throws {ReviewApiError} With `revision_conflict` and the current account when the revision moved.
   */
  public async approveAccount(
    request: { accountId: string; requestId: string; expectedRevision: number | string; suppressApprovedMail: boolean },
    signal?: AbortSignal,
  ): Promise<Account> {
    return decodeAccount((await this.post("approve", request, signal)).account);
  }

  /**
   * Rejects an account if its revision still matches. A repeated `requestId` is idempotent.
   * @throws {ReviewApiError} With `revision_conflict` and the current account when the revision moved.
   */
  public async rejectAccount(
    request: { accountId: string; requestId: string; expectedRevision: number | string },
    signal?: AbortSignal,
  ): Promise<Account> {
    return decodeAccount((await this.post("reject", request, signal)).account);
  }

  private async post(operation: string, payload: object, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(this.settings.requestTimeoutMs ?? defaultRequestTimeoutMs);
    const response = await fetch(`${this.baseUrl}/v1/account-review/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.settings.apiKey}` },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = text === "" ? {} : JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      // A non-JSON body is reported below by its status.
    }
    if (response.ok) {
      return body;
    }
    const error = (typeof body.error === "object" && body.error !== null ? body.error : {}) as Record<string, unknown>;
    const code = Object.values(ReviewApiErrorCode).find((known) => known === error.code) ?? "unexpected";
    const message = typeof error.message === "string" ? error.message.slice(0, 500) : `HTTP ${response.status}`;
    const currentAccount = code === ReviewApiErrorCode.revisionConflict && body.account !== undefined ? decodeAccount(body.account) : undefined;
    throw new ReviewApiError(code, response.status, `ReviewAPI ${operation}: ${message}`, currentAccount);
  }
}
