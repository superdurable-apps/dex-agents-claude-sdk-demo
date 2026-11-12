// fetch_profile refuses private targets before any connection, and keeps only visible text.

import assert from "node:assert/strict";
import test from "node:test";

import { checkProfileUrl, fetchPublicPage, htmlToText, isPublicAddress, ProfileSourceError } from "../src/profile-sources.js";

test("fetch_profile refuses non-HTTPS, credentials, other ports and private or local targets", async () => {
  for (const url of [
    "http://example.com/",
    "https://user:pass@example.com/",
    "https://example.com:8443/",
    "https://127.0.0.1/",
    "https://10.1.2.3/",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/",
    "https://[fd00::1]/",
    "https://localhost/",
    "https://metadata.internal/",
    "not a url",
  ]) {
    assert.throws(() => checkProfileUrl(url), ProfileSourceError, url);
  }
  assert.equal(checkProfileUrl("https://example.com/about").hostname, "example.com");
  // A name that resolves to loopback is refused by the lookup, before any TLS connection.
  await assert.rejects(fetchPublicPage("https://localtest.me/", new AbortController().signal), ProfileSourceError);
});

test("public addresses are told from private ones", () => {
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  for (const address of ["127.0.0.1", "192.168.1.1", "172.20.0.1", "100.64.0.1", "::ffff:127.0.0.1", "fe80::1", "0.0.0.0"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
});

test("HTML becomes visible text without scripts and styles", () => {
  const text = htmlToText("<html><head><style>p{}</style><script>alert(1)</script></head><body><h1>Ada</h1><p>Builds &amp; ships</p></body></html>");
  assert.equal(text, "Ada\nBuilds & ships");
});
