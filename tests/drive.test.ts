import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { ConflictError, driveRequest, loadLibrary, saveBookmark, saveCollection, uploadImage, uploadFile, readImage, trashBookmark, trashCollection } from "../src/lib/drive";
import { validateBookmark, validateFile } from "../src/lib/library";
import type { Bookmark, Library } from "../src/lib/types";

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalStorage = globalThis.localStorage;
const book = { schemaVersion: 1 as const, url: "https://example.com/", title: "Example", description: "", note: "", tags: ["test"] };
const bookmark: Bookmark = { ...book, id: "bookmark", parentId: "collection", version: "1", modifiedTime: "now" };
const f = (id: string, kind: string, parent = "root", extra = {}) => ({ id, name: id, mimeType: kind === "bookmark" || kind === "config" ? "application/json" : "application/vnd.google-apps.folder", parents: [parent], version: "1", modifiedTime: "now", appProperties: { app: "rainbow", kind, library: "root", ...(id === "unsorted" ? { system: "unsorted" } : {}) }, ...extra });
let calls: { url: string; init?: RequestInit }[];
function responses(items: (unknown | Response)[]) {
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (!items.length) throw new Error(`Unexpected request ${url}`);
    const item = items.shift();
    return item instanceof Response ? item : Response.json(item);
  };
}
beforeEach(() => {
  calls = [];
  const tokens = JSON.stringify({ accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 3600000, accountId: "account", email: "test@example.com", name: "Test" });
  const storage = new Map([["rainbow_tokens_v1", tokens]]);
  Object.defineProperty(globalThis, "window", { configurable: true, value: { dispatchEvent() {} } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) } });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: originalStorage });
});
test("initial listing paginates and excludes moved-out collection descendants", async () => {
  responses([{ startPageToken: "start" }, { files: [f("root", "root")] }, { files: [f("assets", "assets"), f("unsorted", "collection"), f("collection", "collection"), f("outside", "collection", "external")], nextPageToken: "page2" }, { files: [f("bookmark", "bookmark", "collection"), f("excluded", "bookmark", "outside")] }, book]);
  const library = await loadLibrary();
  assert.equal(library.changeToken, "start");
  assert.deepEqual(library.bookmarks.map(b => b.id), ["bookmark"]);
  assert.deepEqual(library.collections.map(c => c.id), ["unsorted", "collection"]);
  assert.match(calls[3].url, /pageToken=page2/);
});
test("invalid JSON aborts sync with file name rather than returning an empty library", async () => {
  responses([{ startPageToken: "start" }, { files: [f("root", "root")] }, { files: [f("assets", "assets"), f("unsorted", "collection"), f("bookmark", "bookmark", "unsorted")] }, new Response("broken", { headers: { "Content-Type": "application/json" } })]);
  await assert.rejects(loadLibrary(), /bookmark.*invalid JSON/);
});
test("incremental sync consumes all change pages and reuses unchanged bookmark bodies", async () => {
  const previous: Library = { rootId: "root", assetsId: "assets", unsortedId: "unsorted", collections: [], bookmarks: [bookmark], changeToken: "old", syncedAt: "old" };
  responses([{ changes: [{ fileId: "bookmark" }], nextPageToken: "next" }, { changes: [], newStartPageToken: "new" }, { files: [f("root", "root")] }, { files: [f("assets", "assets"), f("unsorted", "collection"), f("collection", "collection"), f("bookmark", "bookmark", "collection")] }]);
  const current = await loadLibrary(previous);
  assert.equal(current.changeToken, "new");
  assert.equal(current.bookmarks[0].title, "Example");
  assert.equal(calls.filter(c => c.url.includes("alt=media")).length, 0);
});
test("stale bookmark rejects before update and preserves user's input", async () => {
  responses([f("collection", "collection"), f("bookmark", "bookmark", "collection", { version: "2", modifiedTime: "later" })]);
  await assert.rejects(saveBookmark(book, "collection", bookmark), ConflictError);
  assert.equal(calls.some(c => c.init?.method === "PATCH"), false);
  assert.equal(book.title, "Example");
});
test("server-side version bumps (e.g. thumbnail processing) are not conflicts", async () => {
  responses([f("collection", "collection"), f("bookmark", "bookmark", "collection", { version: "5" }), f("bookmark", "bookmark", "collection", { version: "6" })]);
  const saved = await saveBookmark(book, "collection", bookmark);
  assert.equal(saved.version, "6");
});
test("bookmark moves atomically with JSON update and If-Match", async () => {
  responses([f("target", "collection"), Response.json(f("bookmark", "bookmark", "collection"), { headers: { ETag: '"one"' } }), f("bookmark", "bookmark", "target", { version: "2" })]);
  const saved = await saveBookmark(book, "target", bookmark);
  assert.equal(saved.parentId, "target");
  assert.match(calls[2].url, /addParents=target/);
  assert.match(calls[2].url, /removeParents=collection/);
  assert.equal(new Headers(calls[2].init?.headers).get("If-Match"), '"one"');
});
test("HTTP 412 maps to a conflict and create errors are not retried", async () => {
  responses([new Response("", { status: 412 })]);
  await assert.rejects(driveRequest("files/bookmark", { method: "PATCH" }), ConflictError);
  responses([new Response("", { status: 503 })]);
  await assert.rejects(driveRequest("files", { method: "POST" }), /503/);
  assert.equal(calls.length, 2);
});
test("validation excludes executable URLs and overlong tags", () => {
  assert.throws(() => validateBookmark({ ...book, url: "javascript:alert(1)" }), /HTTP/);
  assert.throws(() => validateBookmark({ ...book, tags: ["x".repeat(101)] }), /100/);
});
test("trash uses conditional update; Unsorted cannot be deleted", async () => {
  responses([Response.json(f("bookmark", "bookmark", "collection"), { headers: { ETag: '"one"' } }), {}]);
  await trashBookmark(bookmark);
  assert.equal(calls[1].init?.body, JSON.stringify({ trashed: true }));
  await assert.rejects(trashCollection({ id: "unsorted", name: "Unsorted", parentId: "root", order: 0, view: "grid", system: "unsorted" }), /cannot be deleted/);
});
test("deleting a bookmark also trashes its cover with a conditional update", async () => {
  responses([f("bookmark", "bookmark", "collection"), {}, Response.json(f("image", "asset", "assets"), { headers: { ETag: '"cover"' } }), {}]);
  await trashBookmark({ ...bookmark, coverFileId: "image" });
  assert.deepEqual(calls.filter(c => c.init?.method === "PATCH").map(c => [c.url, c.init?.body]), [
    ["https://www.googleapis.com/drive/v3/files/bookmark", JSON.stringify({ trashed: true })],
    ["https://www.googleapis.com/drive/v3/files/image", JSON.stringify({ trashed: true })],
  ]);
  assert.equal(new Headers(calls[3].init?.headers).get("If-Match"), '"cover"');
});
test("a stale bookmark or failed delete never trashes its cover", async () => {
  for (const items of [
    [f("bookmark", "bookmark", "collection", { modifiedTime: "later" })],
    [f("bookmark", "bookmark", "collection"), new Response("", { status: 412 })],
  ]) {
    calls = [];
    responses(items);
    await assert.rejects(trashBookmark({ ...bookmark, coverFileId: "image" }), ConflictError);
    assert.equal(calls.some(c => c.url.includes("files/image")), false);
  }
});
test("failed cover cleanup can be retried after the bookmark was trashed", async () => {
  responses([f("bookmark", "bookmark", "collection"), {}, f("image", "asset", "assets"), new Response("", { status: 403 })]);
  await assert.rejects(trashBookmark({ ...bookmark, coverFileId: "image" }), /bookmark is in Trash.*Retry deleting/);
  calls = [];
  responses([f("bookmark", "bookmark", "collection", { trashed: true, modifiedTime: "later" }), f("image", "asset", "assets"), {}]);
  await trashBookmark({ ...bookmark, coverFileId: "image" });
  assert.deepEqual(calls.filter(c => c.init?.method === "PATCH").map(c => c.url), ["https://www.googleapis.com/drive/v3/files/image"]);
});
test("already trashed or missing covers do not prevent bookmark deletion", async () => {
  for (const cover of [f("image", "asset", "assets", { trashed: true }), new Response("", { status: 404 })]) {
    calls = [];
    responses([f("bookmark", "bookmark", "collection"), {}, cover]);
    await trashBookmark({ ...bookmark, coverFileId: "image", file: { id: "image", name: "image.png", mimeType: "image/png" } });
    assert.equal(calls.length, 3);
  }
});
test("collection creation writes real folder and companion config", async () => {
  responses([f("root", "root"), f("collection", "collection"), f("config", "config", "collection")]);
  const saved = await saveCollection({ name: "Design", parentId: "root", order: 1, view: "grid" });
  assert.equal(saved.configId, "config");
  assert.equal(saved.configVersion, "1");
  assert.match(String(calls[2].init?.body), /_collection.json/);
});
test("image upload uses asset folder and reads private image content", async () => {
  responses([f("assets", "assets"), { id: "image" }, new Response(new Blob(["image"], { type: "image/png" }))]);
  assert.equal(await uploadImage(new File(["image"], "cover.png", { type: "image/png" }), "assets"), "image");
  assert.equal((await readImage("image")).type, "image/png");
  assert.equal(calls[1].init?.method, "POST");
  await assert.rejects(uploadImage(new File(["bad"], "bad.svg", { type: "image/svg+xml" }), "assets"), /PNG/);
});
test("editing with a cover reattaches thumbnail on every JSON write", async () => {
  const oldDocument = globalThis.document, oldBitmap = globalThis.createImageBitmap;
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillStyle: "", fillRect() {}, drawImage() {} }), toDataURL: () => "data:image/jpeg;base64,dGh1bWI=" }) } });
  globalThis.createImageBitmap = async () => ({ width: 640, height: 480, close() {} }) as ImageBitmap;
  try {
    responses([f("collection", "collection"), new Response(new Blob(["cover"], { type: "image/png" })), f("bookmark", "bookmark", "collection"), f("bookmark", "bookmark", "collection", { version: "2" })]);
    await saveBookmark({ ...book, coverFileId: "image" }, "collection", bookmark);
    assert.match(String(calls[3].init?.body), /contentHints.*thumbnail.*dGh1bWI=/);
  } finally {
    Object.defineProperty(globalThis, "document", { configurable: true, value: oldDocument });
    globalThis.createImageBitmap = oldBitmap;
  }
});
test("401 forces one refresh then retries with the new access token", async () => {
  responses([new Response("", { status: 401 }), { accessToken: "new-access", expiresAt: Date.now() + 3600000 }, { files: [] }]);
  await driveRequest("files");
  assert.equal(calls[1].url, "/api/auth/refresh");
  assert.equal(new Headers(calls[2].init?.headers).get("Authorization"), "Bearer new-access");
});
test("root discovery failures never create a duplicate root", async () => {
  responses([{ startPageToken: "start" }, new Response("", { status: 403 })]);
  await assert.rejects(loadLibrary(), /403/);
  assert.equal(calls.some(c => c.init?.method === "POST"), false);
});

test("403 errors surface Google's reason, with setup guidance when the Drive API is disabled", async () => {
  responses([Response.json({ error: { code: 403, errors: [{ reason: "accessNotConfigured" }] } }, { status: 403 })]);
  await assert.rejects(driveRequest("files"), /Drive API is not enabled/);
});

test("file bookmarks retain attachment metadata through save and reload", async () => {
  const data = { ...book, url: "", file: { id: "asset", name: "notes.pdf", mimeType: "application/pdf" } };
  responses([f("collection", "collection"), f("bookmark", "bookmark", "collection")]);
  const saved = await saveBookmark(data, "collection");
  assert.equal(saved.url, "https://drive.google.com/file/d/asset/view");
  assert.deepEqual(saved.file, data.file);
  assert.match(String(calls[1].init?.body), /notes.pdf/);
  responses([{ startPageToken: "start" }, { files: [f("root", "root")] }, { files: [f("assets", "assets"), f("unsorted", "collection"), f("bookmark", "bookmark", "unsorted")] }, saved]);
  assert.deepEqual((await loadLibrary()).bookmarks[0].file, data.file);
});
test("arbitrary files upload as private assets with a binary MIME fallback", async () => {
  responses([f("assets", "assets"), { id: "asset" }]);
  assert.equal(await uploadFile(new File(["binary content"], "notes.bin"), "assets"), "asset");
  const body = await (calls[1].init?.body as Blob).text();
  assert.match(body, /application\/octet-stream/);
  assert.match(body, /"parents":\["assets"\]/);
  assert.match(body, /binary content/);
  assert.match(body, /"kind":"asset"/);
});
test("file validation rejects empty, oversized, and invalid references", () => {
  assert.throws(() => validateFile(new File([], "empty.txt")), /nonempty/);
  assert.throws(() => validateFile({ size: 50 * 1024 * 1024 + 1, name: "large", type: "" } as File), /50 MB/);
  assert.throws(() => validateBookmark({ ...book, file: { id: "../file", name: "file", mimeType: "text/plain" } }), /reference/);
  assert.throws(() => validateBookmark({ ...book, file: { id: "file", name: "", mimeType: "text/plain" } }), /File name/);
});
test("an image file can use its own asset as the cover even without canvas decoding", async () => {
  const data = { ...book, file: { id: "image", name: "drawing.svg", mimeType: "image/svg+xml" }, coverFileId: "image" };
  responses([f("collection", "collection"), new Response(new Blob(["<svg/>"], { type: "image/svg+xml" })), f("bookmark", "bookmark", "collection")]);
  const saved = await saveBookmark(data, "collection");
  assert.equal(saved.coverFileId, saved.file?.id);
  assert.match(String(calls[2].init?.body), /"coverFileId":"image"/);
});
