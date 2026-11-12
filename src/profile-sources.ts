// Read-only sources the agent uses to learn about an applicant: a public web page and a GitHub user.

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { Agent, request as httpsRequest } from "node:https";
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
  /** Characters of the page that are parsed; the rest is never scanned. */
  maxParsedCharacters: 200_000,
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
    ["::", 96],
    ["2001::", 32],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["fec0::", 10],
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

/** A DNS lookup in the shape `https.request` takes. */
export type Lookup = (
  hostname: string,
  options: object,
  callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
) => void;

/** Wraps a lookup so it refuses every non-public address: the connection goes only to a checked address. */
function publicOnly(lookup: Lookup): Lookup {
  return (hostname, options, callback) => {
    lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error, []);
        return;
      }
      const resolved = addresses as LookupAddress[];
      if (resolved.length === 0 || resolved.some((entry) => !isPublicAddress(entry.address))) {
        callback(new ProfileSourceError("the host resolves to a private or local address"), []);
        return;
      }
      if ((options as { all?: boolean }).all === true) {
        callback(null, resolved);
      } else {
        callback(null, resolved[0]!.address, resolved[0]!.family);
      }
    });
  };
}

/** One HTTP response, read up to a byte limit. */
export interface RawResponse {
  readonly status: number;
  readonly location: string | undefined;
  readonly contentType: string;
  readonly body: Buffer;
  readonly isTruncated: boolean;
}

/** Sends one GET; tests pass their own. */
export type PageTransport = (url: URL, lookup: Lookup, signal: AbortSignal, maxBytes: number) => Promise<RawResponse>;

/** HTTPS GET through its own Agent, so no environment proxy resolves the host instead of the checked lookup. */
const httpsGet: PageTransport = (url, lookup, signal, maxBytes) =>
  new Promise((resolve, reject) => {
    const agent = new Agent({ lookup, keepAlive: false });
    const request = httpsRequest(url, { method: "GET", agent, signal, headers: { "user-agent": "dex-signup-agent-demo/0.1", accept: "text/html,text/plain;q=0.9,*/*;q=0.5" } }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const finish = (isTruncated: boolean) => {
        agent.destroy();
        resolve({ status: response.statusCode ?? 0, location: response.headers.location, contentType: String(response.headers["content-type"] ?? ""), body: Buffer.concat(chunks), isTruncated });
      };
      response.on("data", (chunk: Buffer) => {
        if (size + chunk.length >= maxBytes) {
          chunks.push(chunk.subarray(0, maxBytes - size));
          size = maxBytes;
          response.destroy();
          finish(true);
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      response.on("end", () => finish(false));
      response.on("error", (error) => (size >= maxBytes ? undefined : reject(error)));
    });
    request.on("error", (error) => {
      agent.destroy();
      reject(error);
    });
    request.end();
  });

/**
 * Fetches a public HTTPS page and returns its visible text: at most 1 MB read, 10 seconds, three redirects, each
 * redirect target checked like the first URL, and every resolved address checked before the connection.
 * @throws {ProfileSourceError} When the URL or an address is not allowed, or the fetch fails.
 */
export async function fetchPublicPage(
  rawUrl: string,
  signal: AbortSignal,
  options: { readonly lookup?: Lookup; readonly transport?: PageTransport } = {},
): Promise<ProfilePage> {
  if (process.env.NODE_USE_ENV_PROXY) {
    throw new ProfileSourceError("fetch_profile does not run with NODE_USE_ENV_PROXY set: a proxy would resolve hosts unchecked");
  }
  const lookup = publicOnly(options.lookup ?? (dnsLookup as unknown as Lookup));
  const transport = options.transport ?? httpsGet;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(profilePageLimits.timeoutMs)]);
  let url = checkProfileUrl(rawUrl);
  for (let redirects = 0; ; redirects++) {
    let response: RawResponse;
    try {
      response = await transport(url, lookup, deadline, profilePageLimits.maxBytes);
    } catch (error: unknown) {
      if (error instanceof ProfileSourceError) {
        throw error;
      }
      throw new ProfileSourceError(`fetching ${url.hostname} failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`);
    }
    if (response.status >= 300 && response.status < 400 && response.location !== undefined) {
      if (redirects >= profilePageLimits.maxRedirects) {
        throw new ProfileSourceError("too many redirects");
      }
      url = checkProfileUrl(new URL(response.location, url).toString());
      continue;
    }
    const html = response.body.toString("utf8").slice(0, profilePageLimits.maxParsedCharacters);
    const isHtml = response.contentType.includes("html") || /^\s*<(!doctype|html)/i.test(html.slice(0, 100));
    const text = (isHtml ? htmlToText(html) : html.replace(/\s+/g, " ").trim()).slice(0, profilePageLimits.maxTextCharacters);
    return { url: url.toString(), status: response.status, title: isHtml ? titleOf(html) : "", text, isTruncated: response.isTruncated || text.length >= profilePageLimits.maxTextCharacters };
  }
}

const skippedElements = new Set(["script", "style", "noscript", "svg", "template"]);
const breakingElements = new Set(["br", "p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr"]);

/** Visible text of HTML, in one linear pass with indexOf: no backtracking patterns on page content. */
export function htmlToText(html: string): string {
  const lower = html.toLowerCase();
  let text = "";
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open < 0) {
      text += html.slice(index);
      break;
    }
    text += html.slice(index, open);
    if (html.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4);
      index = end < 0 ? html.length : end + 3;
      text += " ";
      continue;
    }
    const close = html.indexOf(">", open);
    if (close < 0) {
      break;
    }
    const isEnd = html[open + 1] === "/";
    let nameEnd = open + (isEnd ? 2 : 1);
    while (nameEnd < close && /[a-z0-9]/.test(lower[nameEnd]!)) {
      nameEnd++;
    }
    const name = lower.slice(open + (isEnd ? 2 : 1), nameEnd);
    if (!isEnd && skippedElements.has(name)) {
      const end = lower.indexOf(`</${name}`, close);
      const endClose = end < 0 ? -1 : html.indexOf(">", end);
      index = endClose < 0 ? html.length : endClose + 1;
      text += " ";
      continue;
    }
    text += breakingElements.has(name) ? "\n" : " ";
    index = close + 1;
  }
  return decodeEntities(text)
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ ?\n[ \n]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function titleOf(html: string): string {
  const lower = html.toLowerCase();
  const open = lower.indexOf("<title");
  const start = open < 0 ? -1 : lower.indexOf(">", open);
  const end = start < 0 ? -1 : lower.indexOf("</title", start);
  return end < 0 ? "" : decodeEntities(html.slice(start + 1, end)).replace(/\s+/g, " ").trim().slice(0, 300);
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{1,8});/gi, (entity, code: string) => {
    const value = code.startsWith("#x") || code.startsWith("#X") ? Number.parseInt(code.slice(2), 16) : code.startsWith("#") ? Number.parseInt(code.slice(1), 10) : -1;
    if (value >= 0) {
      return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : entity;
    }
    return named[code.toLowerCase()] ?? entity;
  });
}

/** The real sources: public web pages, and the GitHub public REST API with an optional token for its rate limit. */
export class PublicProfileSources implements ProfileSources {
  public constructor(private readonly options: { readonly githubToken?: string } = {}) {}

  public fetchProfilePage(url: string, signal: AbortSignal): Promise<ProfilePage> {
    return fetchPublicPage(url, signal);
  }

  public async fetchGitHubUser(login: string, signal: AbortSignal): Promise<GitHubUserSummary> {
    if (!githubLoginPattern.test(login)) {
      throw new ProfileSourceError(`${login.slice(0, 60)} is not a GitHub login`);
    }
    const user = (await this.getJson(`/users/${login}`, signal)) as Record<string, unknown>;
    const repositories = await this.getJson(`/users/${login}/repos?sort=pushed&per_page=30&type=owner`, signal);
    const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value.slice(0, 500) : null);
    return {
      login: String(user.login ?? login),
      name: text(user.name),
      bio: text(user.bio),
      company: text(user.company),
      blog: text(user.blog),
      location: text(user.location),
      followers: Number(user.followers ?? 0),
      publicRepos: Number(user.public_repos ?? 0),
      createdAt: String(user.created_at ?? ""),
      htmlUrl: String(user.html_url ?? `https://github.com/${login}`),
      topRepositories: (Array.isArray(repositories) ? (repositories as Record<string, unknown>[]) : [])
        .map((repository) => ({
          name: String(repository.name ?? ""),
          description: text(repository.description),
          language: text(repository.language),
          stars: Number(repository.stargazers_count ?? 0),
          pushedAt: text(repository.pushed_at),
          isFork: repository.fork === true,
        }))
        .sort((left, right) => right.stars - left.stars)
        .slice(0, 8),
    };
  }

  /** One GitHub API call, its body read up to 1 MB while it streams. */
  private async getJson(path: string, signal: AbortSignal): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "dex-signup-agent-demo/0.1" };
    if (this.options.githubToken) {
      headers.authorization = `Bearer ${this.options.githubToken}`;
    }
    const response = await fetch(`https://api.github.com${path}`, { headers, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(profilePageLimits.timeoutMs)]) });
    if (response.status === 404) {
      throw new ProfileSourceError("GitHub has no such user");
    }
    if (!response.ok || response.body === null) {
      throw new ProfileSourceError(`GitHub answered HTTP ${response.status}`);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      size += read.value.length;
      if (size > profilePageLimits.maxBytes) {
        await reader.cancel();
        throw new ProfileSourceError("GitHub response is too large");
      }
      chunks.push(read.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  }
}
