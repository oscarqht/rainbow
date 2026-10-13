import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createBookmarkOnServer } from "../src/lib/create-bookmark-server";
import { POST } from "../src/app/api/bookmarks/route";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const data = { schemaVersion: 1 as const, url: "https://example.com/", title: "Example", description: "", note: "", tags: [] };
const parent = { id: "collection", mimeType: "application/vnd.google-apps.folder", parents: ["root"], appProperties: { app: "rainbow", kind: "collection", library: "root" } };

test("server retries a lost create response with the same ID and reconciles 409", async () => {
  const bodies: string[] = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer server-token");
    if (String(url).includes("generateIds")) return Response.json({ ids: ["allocated"] });
    if (String(url).includes("files/collection")) return Response.json(parent);
    if (String(url).includes("files/allocated")) return Response.json({ id: "allocated", modifiedTime: "now", version: "1" });
    bodies.push(String(init?.body));
    if (bodies.length === 1) throw new Error("response lost");
    return new Response(null, { status: 409 });
  };
  const saved = await createBookmarkOnServer(data, "collection", "server-token");
  assert.equal(saved.id, "allocated");
  assert.equal(bodies.length, 2);
  // Multipart boundaries can differ between operations, but retries reuse the entire body.
  assert.equal(bodies[0], bodies[1]);
  assert.match(bodies[0], /"id":"allocated"/);
});

test("server retries transient failures twice and rejects exhausted saves", async () => {
  let writes = 0;
  globalThis.fetch = async url => {
    if (String(url).includes("generateIds")) return Response.json({ ids: ["allocated"] });
    if (String(url).includes("files/collection")) return Response.json(parent);
    writes++;
    return new Response(null, { status: 503 });
  };
  await assert.rejects(createBookmarkOnServer(data, "collection", "server-token"));
  assert.equal(writes, 3);
});

test("endpoint rejects invalid and cross-origin bookmarks before contacting Drive", async () => {
  globalThis.fetch = async () => { throw new Error("Must not contact Drive"); };
  const request = (origin: string, body: unknown) => new Request("http://localhost:3105/api/bookmarks", { method: "POST", headers: { origin, "content-type": "application/json", authorization: "Bearer token" }, body: JSON.stringify(body) });
  assert.equal((await POST(request("https://other.example", { data, parentId: "collection" }))).status, 403);
  assert.equal((await POST(request("http://localhost:3105", { data: { ...data, url: "javascript:alert(1)" }, parentId: "collection" }))).status, 400);
});
