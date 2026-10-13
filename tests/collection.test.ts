import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { saveCollectionOnServer, deleteCollectionOnServer } from "../src/lib/collection-server";
import { POST, PATCH, DELETE } from "../src/app/api/collections/route";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const data = { name: "Reading", parentId: "root", order: 1, view: "grid" as const, color: "#759284" };
const folder = (id: string, kind: string, extra = {}) => ({ id, name: "Reading", mimeType: "application/vnd.google-apps.folder", parents: ["root"], modifiedTime: "old", version: "1", appProperties: { app: "rainbow", kind, library: "root" }, ...extra });
const existing = { ...data, id: "collection", configId: "config", modifiedTime: "old", configModifiedTime: "old" };
const config = (extra = {}) => folder("config", "config", { mimeType: "application/json", parents: ["collection"], ...extra });
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
const request = (method: string, body: unknown, origin = "http://localhost:3105") => new Request("http://localhost:3105/api/collections", { method, headers: { origin, "content-type": "application/json", authorization: "Bearer token" }, body: JSON.stringify(body) });

test("new collections preallocate folder and config IDs and confirm both Drive files", async () => {
  const calls = sequence([{ ids: ["collection", "config"] }, folder("root", "root"), folder("collection", "collection"), config()]);
  const result = await saveCollectionOnServer(data, "token");
  assert.equal(result.id, "collection");
  assert.equal(result.configId, "config");
  assert.match(String(calls[2].init?.body), /"id":"collection"/);
  assert.match(String(calls[3].init?.body), /"id":"config"/);
});

test("lost folder and config create responses reuse IDs and reconcile 409", async () => {
  const calls = sequence([{ ids: ["collection", "config"] }, folder("root", "root"), new Error("lost"), new Response(null, { status: 409 }), folder("collection", "collection"), new Response(null, { status: 409 }), config(), data]);
  const result = await saveCollectionOnServer(data, "token");
  assert.equal(result.id, "collection");
  assert.equal(result.configId, "config");
  assert.equal(calls[2].init?.body, calls[3].init?.body);
});

test("failed settings creation cleans up the newly created folder", async () => {
  const calls = sequence([{ ids: ["collection", "config"] }, folder("root", "root"), folder("collection", "collection"), new Response(null, { status: 403 }), new Response(null, { status: 404 }), folder("collection", "collection"), folder("collection", "collection"), {}]);
  await assert.rejects(saveCollectionOnServer(data, "token"));
  assert.equal(calls.at(-1)?.init?.body, JSON.stringify({ trashed: true }));
  assert.match(calls.at(-1)!.url, /files\/collection$/);
});

test("collection edits confirm lost conditional writes for folder and settings", async () => {
  const changed = { ...data, name: "Updated", view: "list" as const };
  const calls = sequence([folder("root", "root"), Response.json(folder("collection", "collection"), { headers: { ETag: '"folder"' } }), Response.json(config(), { headers: { ETag: '"config"' } }), new Response(null, { status: 412 }), folder("collection", "collection", { name: "Updated", modifiedTime: "new" }), new Response(null, { status: 412 }), config({ modifiedTime: "new" }), changed]);
  const result = await saveCollectionOnServer(changed, "token", existing);
  assert.equal(result.name, "Updated");
  assert.equal(result.view, "list");
  assert.equal(result.configModifiedTime, "new");
  assert.equal(new Headers(calls[3].init?.headers).get("If-Match"), '"folder"');
  assert.equal(new Headers(calls[5].init?.headers).get("If-Match"), '"config"');
});

test("stale settings and descendant moves are rejected before any Drive writes", async () => {
  let calls = sequence([folder("root", "root"), folder("collection", "collection"), config({ modifiedTime: "newer" })]);
  await assert.rejects(saveCollectionOnServer(data, "token", existing), /changed in another browser/);
  assert.equal(calls.some(c => c.init?.method === "PATCH"), false);
  calls = sequence([folder("child", "collection", { parents: ["collection"] }), folder("collection", "collection"), folder("child", "collection", { parents: ["collection"] })]);
  await assert.rejects(saveCollectionOnServer({ ...data, parentId: "child" }, "token", existing), /descendants/);
  assert.equal(calls.some(c => c.init?.method === "PATCH"), false);
});

test("collection deletion confirms a lost response and rejects real Unsorted even if browser omits its system flag", async () => {
  const calls = sequence([folder("collection", "collection"), Response.json(folder("collection", "collection"), { headers: { ETag: '"folder"' } }), new Error("lost"), new Response(null, { status: 412 }), folder("collection", "collection", { trashed: true })]);
  await deleteCollectionOnServer(existing, "token");
  assert.equal(calls[2].init?.body, calls[3].init?.body);
  sequence([folder("unsorted", "collection", { appProperties: { app: "rainbow", kind: "collection", library: "root", system: "unsorted" } })]);
  await assert.rejects(deleteCollectionOnServer({ ...existing, id: "unsorted" }, "token"), /cannot be deleted/);
});

test("editing Unsorted preserves its system marker in the confirmed response", async () => {
  const system = folder("unsorted", "collection", { appProperties: { app: "rainbow", kind: "collection", library: "root", system: "unsorted" } });
  sequence([folder("root", "root"), system, config({ parents: ["unsorted"] }), system, config()]);
  const result = await saveCollectionOnServer(data, "token", { ...existing, id: "unsorted" });
  assert.equal(result.system, "unsorted");
});

test("collection routes reject invalid references and cross-origin requests", async () => {
  globalThis.fetch = async () => { throw new Error("Must not access Drive"); };
  assert.equal((await POST(request("POST", { data }, "https://other.example"))).status, 403);
  assert.equal((await POST(request("POST", { data: { ...data, name: "" } }))).status, 400);
  for (const [method, handler] of [["PATCH", PATCH], ["DELETE", DELETE]] as const) {
    assert.equal((await handler(request(method, { data, existing: { ...existing, id: "../outside" } }))).status, 400);
  }
});

test("expired authorization after folder creation does not ask the browser to replay a whole create", async () => {
  sequence([{ ids: ["collection", "config"] }, folder("root", "root"), folder("collection", "collection"), new Response(null, { status: 401 }), new Response(null, { status: 401 }), new Response(null, { status: 401 })]);
  const result = await POST(request("POST", { data }));
  assert.equal(result.status, 502);
});
