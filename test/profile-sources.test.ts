// fetch_profile refuses private targets before any connection, follows only checked redirects, and parses in linear time.

import assert from "node:assert/strict";
import test from "node:test";

import { checkProfileUrl, fetchPublicPage, htmlToText, isPublicAddress, ProfileSourceError, type Lookup, type PageTransport } from "../src/profile-sources.js";

const signal = () => new AbortController().signal;

test("fetch_profile refuses non-HTTPS, credentials, other ports and private or local targets", () => {
  for (const url of [
    "http://example.com/",
    "https://user:pass@example.com/",
    "https://example.com:8443/",
    "https://127.0.0.1/",
    "https://10.1.2.3/",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/",
    "https://[fd00::1]/",
    "https://[2002:7f00:1::]/",
    "https://localhost/",
    "https://metadata.internal/",
    "not a url",
  ]) {
    assert.throws(() => checkProfileUrl(url), ProfileSourceError, url);
  }
  assert.equal(checkProfileUrl("https://example.com/about").hostname, "example.com");
});

test("a host that resolves to a private address is refused before any connection", async () => {
  const lookup: Lookup = (_hostname, _options, callback) => callback(null, [{ address: "10.0.0.7", family: 4 }]);
  await assert.rejects(fetchPublicPage("https://profile.example/", signal(), { lookup }), /private or local address/);
});

test("a redirect to a private address is refused", async () => {
  const requested: string[] = [];
  const transport: PageTransport = async (url) => {
    requested.push(url.toString());
    return { status: 302, location: "https://192.168.1.1/admin", contentType: "", body: Buffer.alloc(0), isTruncated: false };
  };
  await assert.rejects(fetchPublicPage("https://profile.example/", signal(), { transport }), /private or local address/);
  assert.deepEqual(requested, ["https://profile.example/"]);
});

test("public addresses are told from private ones", () => {
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  for (const address of ["127.0.0.1", "192.168.1.1", "172.20.0.1", "100.64.0.1", "::ffff:127.0.0.1", "fe80::1", "0.0.0.0", "2001::1", "2002:a00::1", "fec0::1", "::a00:1"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
});

test("HTML becomes visible text without scripts and styles", () => {
  const text = htmlToText("<html><head><style>p{}</style><script>alert(1)</script></head><body><h1>Ada</h1><p>Builds &amp; ships</p><!-- note --></body></html>");
  assert.equal(text, "Ada\nBuilds & ships");
});

test("adversarial HTML parses well under a second", async () => {
  for (const unit of ["<", "<svg ", "<!--", "<title>", "<a <b <c", "&aaaaaaaa", " \n"]) {
    const html = unit.repeat(Math.ceil((1024 * 1024) / unit.length));
    const transport: PageTransport = async () => ({ status: 200, location: undefined, contentType: "text/html", body: Buffer.from(html), isTruncated: true });
    const startedAt = performance.now();
    await fetchPublicPage("https://profile.example/", signal(), { transport });
    htmlToText(html.slice(0, 200_000));
    assert.ok(performance.now() - startedAt < 1_000, `${JSON.stringify(unit)} took ${performance.now() - startedAt} ms`);
  }
});
