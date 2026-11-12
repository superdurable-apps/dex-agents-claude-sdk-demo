// Read-only sources the agent uses to learn about an applicant: a public web page and a GitHub user.

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

/** What the agent's read tools can fetch. Tests replace it; the default reaches the public internet. */
export interface ProfileSources {
  /** Returns the visible text of a public HTTPS page. */
  fetchProfilePage(url: string, signal: AbortSignal): Promise<ProfilePage>;
  /** Returns a GitHub user's public profile and their most starred recent repositories. */
  fetchGitHubUser(login: string, signal: AbortSignal): Promise<GitHubUserSummary>;
}

/** The text of one fetched page. */
export interface ProfilePage {
  readonly url: string;
  readonly status: number;
  readonly title: string;
  readonly text: string;
  readonly isTruncated: boolean;
}

/** The public facts of one GitHub user. */
export interface GitHubUserSummary {
  readonly login: string;
  readonly name: string | null;
  readonly bio: string | null;
  readonly company: string | null;
  readonly blog: string | null;
  readonly location: string | null;
  readonly followers: number;
  readonly publicRepos: number;
  readonly createdAt: string;
  readonly htmlUrl: string;
  readonly topRepositories: readonly {
    readonly name: string;
    readonly description: string | null;
    readonly language: string | null;
    readonly stars: number;
    readonly pushedAt: string | null;
    readonly isFork: boolean;
  }[];
}

/** A failure the agent should read, such as a blocked address or a 404. */
export class ProfileSourceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProfileSourceError";
  }
}

/** Limits of {@link fetchPublicPage}. */
export const profilePageLimits = {
  maxBytes: 1024 * 1024,
  timeoutMs: 10_000,
  maxRedirects: 3,
  maxTextCharacters: 20_000,
} as const;

const githubLoginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** Addresses a fetch must never reach: loopback, private, link-local, carrier-grade NAT, multicast and reserved. */
const blockedAddresses = (() => {
  const list = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const) {
    list.addSubnet(network, prefix, "ipv4");
  }
  for (const [network, prefix] of [
    ["::", 128],
    ["::1", 128],
    // IPv4-mapped addresses (::ffff:a.b.c.d) are checked against the IPv4 subnets above by BlockList itself.
    ["64:ff9b::", 96],
    ["100::", 64],
    ["2001:db8::", 32],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
  ] as const) {
    list.addSubnet(network, prefix, "ipv6");
  }
  return list;
})();

/** Whether an IP address is one a public fetch may connect to. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) {
    return false;
  }
  return !blockedAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
}

/**
 * Checks a URL before any connection: HTTPS only, no credentials, default port, and no literal non-public address.
 * @throws {ProfileSourceError} When the URL is not allowed.
 */
export function checkProfileUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ProfileSourceError(`not a valid URL: ${rawUrl.slice(0, 200)}`);
  }
  if (url.protocol !== "https:") {
    throw new ProfileSourceError("only https URLs can be fetched");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ProfileSourceError("URLs with credentials are not fetched");
  }
  if (url.port !== "" && url.port !== "443") {
    throw new ProfileSourceError("only the default HTTPS port is fetched");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0 && !isPublicAddress(host)) {
    throw new ProfileSourceError("the URL points to a private or local address");
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new ProfileSourceError("the URL points to a private or local host");
  }
  return url;
}

/** A DNS lookup that refuses every non-public address, so the connection goes only to a checked address. */
function publicOnlyLookup(
  hostname: string,
  options: object,
  callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
): void {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, []);
      return;
    }
    const resolved = addresses as LookupAddress[];
    const blocked = resolved.find((entry) => !isPublicAddress(entry.address));
    if (blocked !== undefined || resolved.length === 0) {
      const refusal: NodeJS.ErrnoException = new ProfileSourceError("the host resolves to a private or local address");
      refusal.code = "EADDRNOTPUBLIC";
      callback(refusal, []);
      return;
    }
    if ((options as { all?: boolean }).all === true) {
      callback(null, resolved);
    } else {
      callback(null, resolved[0]!.address, resolved[0]!.family);
    }
  });
}

interface RawResponse {
  readonly status: number;
  readonly location: string | undefined;
  readonly contentType: string;
  readonly body: Buffer;
  readonly isTruncated: boolean;
}

function getOnce(url: URL, signal: AbortSignal, maxBytes: number): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: "GET",
        lookup: publicOnlyLookup,
        signal,
        headers: { "user-agent": "dex-signup-agent-demo/0.1", accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let isTruncated = false;
        response.on("data", (chunk: Buffer) => {
          if (isTruncated) {
            return;
          }
          if (size + chunk.length > maxBytes) {
            chunks.push(chunk.subarray(0, maxBytes - size));
            size = maxBytes;
            isTruncated = true;
            response.destroy();
            finish();
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        let isDone = false;
        const finish = (): void => {
          if (isDone) {
            return;
          }
          isDone = true;
          resolve({
            status: response.statusCode ?? 0,
            location: response.headers.location,
            contentType: String(response.headers["content-type"] ?? ""),
            body: Buffer.concat(chunks),
            isTruncated,
          });
        };
        response.on("end", finish);
        response.on("error", (error) => (isTruncated ? finish() : reject(error)));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

/**
 * Fetches a public HTTPS page and returns its visible text: at most 1 MB read, 10 seconds, three redirects, each
 * redirect target checked like the first URL, and every resolved address checked before the connection.
 * @throws {ProfileSourceError} When the URL or an address is not allowed, or the fetch fails.
 */
export async function fetchPublicPage(rawUrl: string, signal: AbortSignal): Promise<ProfilePage> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(profilePageLimits.timeoutMs)]);
  let url = checkProfileUrl(rawUrl);
  for (let redirects = 0; ; redirects++) {
    let response: RawResponse;
    try {
      response = await getOnce(url, deadline, profilePageLimits.maxBytes);
    } catch (error: unknown) {
      if (error instanceof ProfileSourceError) {
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new ProfileSourceError(`fetching ${url.hostname} failed: ${reason.slice(0, 200)}`);
    }
    if (response.status >= 300 && response.status < 400 && response.location !== undefined) {
      if (redirects >= profilePageLimits.maxRedirects) {
        throw new ProfileSourceError("too many redirects");
      }
      url = checkProfileUrl(new URL(response.location, url).toString());
      continue;
    }
    const decoded = response.body.toString("utf8");
    const isHtml = response.contentType.includes("html") || /^\s*<(!doctype|html)/i.test(decoded);
    const text = (isHtml ? htmlToText(decoded) : decoded.replace(/\s+/g, " ").trim()).slice(0, profilePageLimits.maxTextCharacters);
    return {
      url: url.toString(),
      status: response.status,
      title: isHtml ? decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(decoded)?.[1] ?? "").trim().slice(0, 300) : "",
      text,
      isTruncated: response.isTruncated || text.length >= profilePageLimits.maxTextCharacters,
    };
  }
}

/** Strips scripts, styles and tags from HTML and collapses whitespace. */
export function htmlToText(html: string): string {
  const withoutCode = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(withoutCode)
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) {
      return safeCodePoint(Number.parseInt(code.slice(2), 16), entity);
    }
    if (code.startsWith("#")) {
      return safeCodePoint(Number.parseInt(code.slice(1), 10), entity);
    }
    return named[code.toLowerCase()] ?? entity;
  });
}

function safeCodePoint(value: number, fallback: string): string {
  return Number.isInteger(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : fallback;
}

/** Settings of {@link PublicProfileSources}. */
export interface PublicProfileSourcesOptions {
  /** GitHub REST API base URL; defaults to `https://api.github.com`. */
  readonly githubApiBaseUrl?: string;
  /** Optional GitHub token for a higher rate limit; read-only public data needs none. */
  readonly githubToken?: string;
}

/** The real sources: public web pages and the GitHub public REST API. */
export class PublicProfileSources implements ProfileSources {
  private readonly githubApiBaseUrl: string;

  public constructor(private readonly options: PublicProfileSourcesOptions = {}) {
    this.githubApiBaseUrl = (options.githubApiBaseUrl ?? "https://api.github.com").replace(/\/+$/, "");
  }

  public fetchProfilePage(url: string, signal: AbortSignal): Promise<ProfilePage> {
    return fetchPublicPage(url, signal);
  }

  public async fetchGitHubUser(login: string, signal: AbortSignal): Promise<GitHubUserSummary> {
    if (!githubLoginPattern.test(login)) {
      throw new ProfileSourceError(`${login.slice(0, 60)} is not a GitHub login`);
    }
    const user = await this.getJson(`/users/${login}`, signal);
    const repositories = await this.getJson(`/users/${login}/repos?sort=pushed&per_page=30&type=owner`, signal);
    const repositoryList = Array.isArray(repositories) ? (repositories as Record<string, unknown>[]) : [];
    const record = user as Record<string, unknown>;
    const textOrNull = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value.slice(0, 500) : null);
    return {
      login: String(record.login ?? login),
      name: textOrNull(record.name),
      bio: textOrNull(record.bio),
      company: textOrNull(record.company),
      blog: textOrNull(record.blog),
      location: textOrNull(record.location),
      followers: Number(record.followers ?? 0),
      publicRepos: Number(record.public_repos ?? 0),
      createdAt: String(record.created_at ?? ""),
      htmlUrl: String(record.html_url ?? `https://github.com/${login}`),
      topRepositories: repositoryList
        .map((repository) => ({
          name: String(repository.name ?? ""),
          description: textOrNull(repository.description),
          language: textOrNull(repository.language),
          stars: Number(repository.stargazers_count ?? 0),
          pushedAt: textOrNull(repository.pushed_at),
          isFork: repository.fork === true,
        }))
        .sort((left, right) => right.stars - left.stars)
        .slice(0, 8),
    };
  }

  private async getJson(path: string, signal: AbortSignal): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "dex-signup-agent-demo/0.1" };
    if (this.options.githubToken) {
      headers.authorization = `Bearer ${this.options.githubToken}`;
    }
    const response = await fetch(`${this.githubApiBaseUrl}${path}`, {
      headers,
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(profilePageLimits.timeoutMs)]),
    });
    if (response.status === 404) {
      throw new ProfileSourceError("GitHub has no such user");
    }
    if (!response.ok) {
      throw new ProfileSourceError(`GitHub answered HTTP ${response.status}`);
    }
    const text = await response.text();
    if (text.length > profilePageLimits.maxBytes) {
      throw new ProfileSourceError("GitHub response is too large");
    }
    return JSON.parse(text) as unknown;
  }
}
