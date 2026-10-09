import assert from "node:assert/strict";
import { test } from "node:test";
import { createWebExecutor, htmlToText, isPrivateAddress, isWebTool, parseSearchResults, webTools } from "./web-tools.js";

const DDG = `<html><body>
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdeveloper.apple.com%2Fforums%2Fthread%2F123&amp;rut=abc">Cloud signing permission error &amp; fix</a></h2>
  <a class="result__snippet" href="x">Use an <b>Admin</b> API key for cloud managed certificates.</a>
</div>
<div class="result results_links">
  <h2><a class="result__a" href="https://stackoverflow.com/q/1">Second result</a></h2>
  <a class="result__snippet">Another snippet</a>
</div>
<div class="result"><h2><a class="result__a" href="http://insecure.example/x">Insecure</a></h2></div>
</body></html>`;

const publicHost = async () => ["93.184.216.34"];
const respond = (body: string, init: { status?: number; type?: string; headers?: Record<string, string> } = {}) =>
  new Response(body, { status: init.status ?? 200, headers: { "content-type": init.type ?? "text/html", ...(init.headers ?? {}) } });

test("search results are parsed, redirects unwrapped, and non-https hits dropped", () => {
  const hits = parseSearchResults(DDG);
  assert.equal(hits.length, 2);
  assert.deepEqual(hits[0], { title: "Cloud signing permission error & fix", url: "https://developer.apple.com/forums/thread/123", snippet: "Use an Admin API key for cloud managed certificates." });
  assert.equal(hits[1].url, "https://stackoverflow.com/q/1");
  assert.deepEqual(parseSearchResults("<html>nothing</html>"), []);
});

test("web_search returns untrusted-labelled results and refuses queries that look like secrets", async () => {
  const requested: string[] = [];
  const run = createWebExecutor({ resolve: publicHost, fetch: (async (url: URL) => { requested.push(String(url)); return respond(DDG); }) as never });
  const ok = await run("web_search", { query: "xcodebuild Cloud signing permission error" });
  const parsed = JSON.parse(ok.content);
  assert.match(parsed.notice, /UNTRUSTED/); assert.equal(parsed.results.length, 2);
  assert.match(requested[0], /^https:\/\/html\.duckduckgo\.com\/html\/\?q=xcodebuild%20Cloud/);
  for (const bad of ["altool --apiKey ABC123DEF4", "password=hunter22 failed", "issuer 69a6de70-03db-47e3-e053-5b8c7c11a4d1", `error ${"A1b2".repeat(15)}`, "-----BEGIN PRIVATE KEY----- x", "AuthKey_HV633F9Y44 not found"]) {
    const refused = await run("web_search", { query: bad });
    assert.equal(refused.isError, true, bad); assert.match(refused.content, /secret|key|token|identifier/i);
  }
  assert.equal(requested.length, 1, "refused queries never reach the network");
  assert.equal((await run("web_search", { query: "" })).isError, true);
  assert.equal((await run("web_search", { query: "x".repeat(201) })).isError, true);
});

test("web_fetch refuses non-https, credentials, local and private addresses, including after redirects", async () => {
  const fetched: string[] = [];
  const resolve = async (host: string) => host === "internal.example.com" ? ["10.0.0.5"] : ["93.184.216.34"];
  const run = createWebExecutor({ resolve, fetch: (async (url: URL) => {
    fetched.push(String(url));
    if (String(url).includes("redirector")) return new Response(null, { status: 302, headers: { location: "https://internal.example.com/admin" } });
    return respond("<html><title>Doc</title><body>ok</body></html>");
  }) as never });
  for (const url of ["http://example.com", "https://user:pass@example.com/", "https://localhost/x", "https://127.0.0.1/x", "https://192.168.1.1/x", "https://[::1]/x", "https://169.254.169.254/latest/meta-data", "https://example.com:8443/x", "https://internal.example.com/x", "https://printer.local/x", "not a url"]) {
    const result = await run("web_fetch", { url });
    assert.equal(result.isError, true, url);
  }
  assert.equal(fetched.length, 0, "nothing blocked was requested");
  const redirected = await run("web_fetch", { url: "https://redirector.example.com/go" });
  assert.equal(redirected.isError, true); assert.match(redirected.content, /Private, loopback/);
  assert.deepEqual(fetched, ["https://redirector.example.com/go"]);
});

test("web_fetch returns cleaned text and enforces type, size and status limits", async () => {
  const html = `<html><head><title>Xcode &amp; signing</title><style>.a{}</style><script>alert(1)</script></head><body><h1>Heading</h1><p>Use <b>Admin</b> keys.</p><script>steal()</script></body></html>`;
  const big = "x".repeat(2_000_000);
  const run = createWebExecutor({ resolve: publicHost, maxFetches: 20, fetch: (async (url: URL) => {
    const u = String(url);
    if (u.endsWith("/page")) return respond(html);
    if (u.endsWith("/pdf")) return respond("%PDF", { type: "application/pdf" });
    if (u.endsWith("/missing")) return respond("no", { status: 404 });
    if (u.endsWith("/big")) return respond(big, { type: "text/plain" });
    return respond("", { status: 500 });
  }) as never });
  const page = JSON.parse((await run("web_fetch", { url: "https://example.com/page" })).content);
  assert.equal(page.title, "Xcode & signing");
  assert.match(page.text, /Heading\nUse Admin keys\./); assert.ok(!/alert|steal/.test(page.text)); assert.match(page.notice, /UNTRUSTED/);
  assert.match((await run("web_fetch", { url: "https://example.com/pdf" })).content, /non-text/);
  assert.match((await run("web_fetch", { url: "https://example.com/missing" })).content, /HTTP 404/);
  const capped = JSON.parse((await run("web_fetch", { url: "https://example.com/big" })).content);
  assert.ok(capped.text.length <= 12_000); assert.equal(capped.truncated, true);
});

test("fetched text is scrubbed of anything credential-shaped, and per-conversation limits apply", async () => {
  const run = createWebExecutor({ resolve: publicHost, maxSearches: 2, maxFetches: 1, fetch: (async () => respond("<p>token: abc123SECRETvalue and --apiKey LEAKME1234</p>")) as never });
  const page = JSON.parse((await run("web_fetch", { url: "https://example.com/a" })).content);
  assert.ok(!page.text.includes("abc123SECRETvalue") && !page.text.includes("LEAKME1234"));
  assert.match((await run("web_fetch", { url: "https://example.com/b" })).content, /Fetch limit reached/);
  await run("web_search", { query: "one" }); await run("web_search", { query: "two" });
  assert.match((await run("web_search", { query: "three" })).content, /Search limit reached/);
});

test("address classification and html cleanup helpers", () => {
  for (const address of ["10.1.2.3", "127.0.0.1", "172.20.0.1", "192.168.0.9", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "224.0.0.1", "garbage"]) assert.equal(isPrivateAddress(address), true, address);
  for (const address of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"]) assert.equal(isPrivateAddress(address), false, address);
  assert.deepEqual(htmlToText("<title> A </title><p>x &lt; y</p>"), { title: "A", text: "x < y" });
  assert.deepEqual(webTools.map((tool) => tool.name), ["web_search", "web_fetch"]);
  assert.ok(isWebTool("web_fetch") && !isWebTool("ios_run_operation"));
});
