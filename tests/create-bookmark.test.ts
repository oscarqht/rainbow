import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createBookmarkOnServer, editBookmarkOnServer, deleteBookmarkOnServer } from "../src/lib/create-bookmark-server";
import { POST, PATCH, DELETE } from "../src/app/api/bookmarks/route";

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

const existing = { ...data, id: "bookmark", parentId: "collection", modifiedTime: "old", version: "1" };
const stored = (extra = {}) => ({ id: "bookmark", name: "Example.json", parents: ["collection"], modifiedTime: "old", version: "1", appProperties: { app: "rainbow", kind: "bookmark", library: "root" }, ...extra });
function sequence(items: (object | Response | Error)[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    assert.ok(items.length, `Unexpected request: ${url}`);
    const item = items.shift();
    if (item instanceof Error) throw item;
    return item instanceof Response ? item : Response.json(item);
  };
  return calls;
}

test("server edit updates content and collection conditionally, then returns confirmed metadata", async () => {
  const calls = sequence([parent, Response.json(stored({ parents: ["other"] }), { headers: { ETag: '"original"' } }), stored({ modifiedTime: "new", version: "2" })]);
  const result = await editBookmarkOnServer({ ...data, title: "Edited" }, "collection", existing, "token");
  assert.equal(result.title, "Edited");
  assert.equal(result.modifiedTime, "new");
  assert.equal(new Headers(calls[2].init?.headers).get("If-Match"), '"original"');
  assert.match(calls[2].url, /addParents=collection.*removeParents=other/);
  assert.match(String(calls[2].init?.body), /Edited.json/);
});

test("a lost edit response is confirmed after its retry fails If-Match", async () => {
  const edited = { ...data, title: "Edited" };
  const calls = sequence([parent, Response.json(stored(), { headers: { ETag: '"original"' } }), new Error("response lost"), new Response(null, { status: 412 }), stored({ name: "Edited.json", modifiedTime: "new", version: "2" }), edited]);
  const result = await editBookmarkOnServer(edited, "collection", existing, "token");
  assert.equal(result.modifiedTime, "new");
  assert.equal(calls[2].init?.body, calls[3].init?.body);
});

test("stale edits and failed deletions never overwrite newer data or trash covers", async () => {
  let calls = sequence([parent, stored({ modifiedTime: "newer" }), stored({ modifiedTime: "newer" }), { ...data, note: "Someone else's note" }]);
  await assert.rejects(editBookmarkOnServer(data, "collection", existing, "token"), /changed in another browser/);
  assert.equal(calls.some(c => c.init?.method === "PATCH"), false);
  calls = sequence([stored({ modifiedTime: "newer" }), { ...data, coverFileId: "cover" }, stored({ modifiedTime: "newer" })]);
  await assert.rejects(deleteBookmarkOnServer(existing, "token"), /changed in another browser/);
  assert.equal(calls.some(c => c.init?.method === "PATCH"), false);
});

test("delete confirms a lost trash response and cleans up the cover saved in Drive", async () => {
  const calls = sequence([stored(), { ...data, coverFileId: "real_cover" }, Response.json(stored(), { headers: { ETag: '"original"' } }), new Error("response lost"), new Response(null, { status: 412 }), stored({ trashed: true }), { id: "real_cover", modifiedTime: "old" }, {}]);
  await deleteBookmarkOnServer({ ...existing, coverFileId: "untrusted_cover" }, "token");
  assert.equal(calls[3].init?.body, calls[4].init?.body);
  assert.equal(calls.some(c => c.url.includes("untrusted_cover")), false);
  assert.match(calls.at(-1)!.url, /files\/real_cover$/);
});

test("delete endpoint reports partial cover cleanup without claiming the bookmark still exists", async () => {
  sequence([stored(), { ...data, coverFileId: "cover" }, stored(), {}, { id: "cover" }, new Response(null, { status: 403 }), { id: "cover", trashed: false }]);
  const result = await DELETE(new Request("http://localhost:3105/api/bookmarks", { method: "DELETE", headers: { origin: "http://localhost:3105", "content-type": "application/json", authorization: "Bearer token" }, body: JSON.stringify({ existing }) }));
  assert.equal(result.status, 502);
  assert.equal((await result.json()).bookmarkDeleted, true);
});

test("edit and delete endpoints validate references before accessing Drive", async () => {
  globalThis.fetch = async () => { throw new Error("Must not contact Drive"); };
  for (const [method, handler] of [["PATCH", PATCH], ["DELETE", DELETE]] as const) {
    const result = await handler(new Request("http://localhost:3105/api/bookmarks", { method, headers: { origin: "http://localhost:3105", "content-type": "application/json", authorization: "Bearer token" }, body: JSON.stringify({ data, parentId: "collection", existing: { ...existing, id: "../outside" } }) }));
    assert.equal(result.status, 400);
  }
});
