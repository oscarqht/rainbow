import { test, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import https from "node:https";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { fetchUrlMetadata, isPublicAddress, parseMetadata } from "../src/lib/url-metadata";
import { POST } from "../src/app/api/url-metadata/route";

afterEach(() => mock.restoreAll());

test("parses real HTML attributes, entities, metadata priorities and length limits", () => {
  assert.deepEqual(parseMetadata(`<title>Fallback &amp; title</title><META CONTENT='A &quot;quote&quot; &amp; more > text' NAME=description><meta content="Social title" property="og:title"><meta property="og:description" content="Social description">`), { title: "Social title", description: 'A "quote" & more > text' });
  assert.deepEqual(parseMetadata("<title>  A\n &copy; B </title>"), { title: "A © B", description: "" });
  assert.deepEqual(parseMetadata('<meta name="twitter:title" content="Tweet"><meta name="twitter:description" content="Summary">'), { title: "Tweet", description: "Summary" });
  assert.equal(parseMetadata(`<title>${"x".repeat(600)}</title>`).title.length, 500);
  assert.equal(parseMetadata(`<meta name="description" content="${"x".repeat(6000)}">`).description.length, 5000);
  assert.deepEqual(parseMetadata("<script>const title = '<title>Fake</title>'</script>"), { title: "", description: "" });
});

test("blocks private, mapped, reserved and metadata-service addresses", () => {
  for (const address of ["127.0.0.1", "10.1.1.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "2002:7f00:1::", "2001:db8::1"]) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress("93.184.216.34"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});

// Exercise the actual request options and DNS callback without external traffic.
function mockPage(page: (url: URL) => { status?: number; location?: string; type?: string; html?: string }, addresses = [{ address: "93.184.216.34", family: 4 }]) {
  const urls: URL[] = [];
  mock.method(dns, "lookup", (_host: string, _options: unknown, callback: (error: null, addresses: { address: string; family: number }[]) => void) => callback(null, addresses));
  mock.method(https, "get", (url: URL, options: { headers: Record<string, string>; agent: boolean; signal: AbortSignal; lookup: (host: string, options: object, callback: (error: Error | null, address: string) => void) => void }, callback: (response: Readable) => void) => {
    urls.push(url);
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.agent, false);
    assert.ok(options.signal);
    const request = new EventEmitter() as EventEmitter & { destroy: (error: Error) => void };
    request.destroy = error => request.emit("error", error);
    queueMicrotask(() => options.lookup(url.hostname, {}, (error: Error | null, address: string) => {
      if (error) { request.emit("error", error); return; }
      assert.equal(address, addresses[0].address);
      const result = page(url);
      const response = Readable.from([Buffer.from(result.html ?? "<title>Fetched title</title><meta name=description content='Fetched summary'>")]);
      Object.assign(response, { statusCode: result.status ?? 200, headers: { "content-type": result.type ?? "text/html; charset=utf-8", location: result.location } });
      callback(response);
    }));
    return request;
  });
  return urls;
}

test("fetches HTML through pinned public DNS and follows relative redirects", async () => {
  const urls = mockPage(url => url.pathname === "/start" ? { status: 302, location: "/final" } : {});
  assert.deepEqual(await fetchUrlMetadata("https://example.com/start"), { title: "Fetched title", description: "Fetched summary" });
  assert.deepEqual(urls.map(url => url.pathname), ["/start", "/final"]);
});

test("rejects private DNS answers and redirects to private addresses", async () => {
  mockPage(() => ({}), [{ address: "10.0.0.1", family: 4 }]);
  await assert.rejects(fetchUrlMetadata("https://example.com"), /Private/);
  mock.restoreAll();
  const urls = mockPage(() => ({ status: 302, location: "http://127.0.0.1/secret" }));
  await assert.rejects(fetchUrlMetadata("https://example.com"), /Unsupported/);
  assert.equal(urls.length, 1);
});

test("rejects oversized, non-HTML, failed pages and redirect loops", async () => {
  for (const page of [{ html: "x".repeat(1_000_001) }, { type: "application/pdf" }, { status: 404 }, { status: 302, location: "/loop" }]) {
    mockPage(() => page);
    await assert.rejects(fetchUrlMetadata("https://example.com"));
    mock.restoreAll();
  }
});

const request = (body: unknown, origin = "http://localhost:3117") => new Request("http://localhost:3117/api/url-metadata", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
test("endpoint returns metadata without Drive credentials and degrades to empty metadata", async () => {
  mockPage(() => ({}));
  const response = await POST(request({ url: "https://example.com" }));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { title: "Fetched title", description: "Fetched summary" });
  assert.deepEqual(await (await POST(request({ url: "http://127.0.0.1" }))).json(), { title: "", description: "" });
});

test("endpoint rejects cross-origin, invalid and oversized input", async () => {
  assert.equal((await POST(request({ url: "https://example.com" }, "https://other.example"))).status, 403);
  for (const body of [{ url: "file:///etc/passwd" }, { url: "bad" }, {}, { url: "https://example.com/" + "x".repeat(20_000) }]) assert.equal((await POST(request(body))).status, 400);
});
