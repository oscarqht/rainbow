import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { enrichBookmark } from "../src/lib/enrich-bookmark";

const originalFetch = globalThis.fetch;
const originalBitmap = globalThis.createImageBitmap;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalBitmap) globalThis.createImageBitmap = originalBitmap;
  else Reflect.deleteProperty(globalThis, "createImageBitmap");
});
const input = { schemaVersion: 1 as const, url: "https://example.com/", title: "", description: "", note: "My note", tags: ["reading"] };
const upload = async () => "cover-id";

test("enrichment waits for background metadata and fills only missing fields", async () => {
  let resolve!: (response: Response) => void;
  globalThis.fetch = async () => new Promise<Response>(done => { resolve = done; });
  const task = enrichBookmark(input, upload);
  assert.equal(input.title, "");
  resolve(Response.json({ title: "Fetched title", description: "Fetched summary" }));
  assert.deepEqual(await task, { ...input, title: "Fetched title", description: "Fetched summary" });
});

test("preserves supplied text and cover while filling missing description", async () => {
  globalThis.fetch = async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).fetchImage, false);
    return Response.json({ title: "Fetched title", description: "Fetched summary", thumbnail: { data: "eA==", mimeType: "image/png" } });
  };
  const supplied = { ...input, title: "My title", coverFileId: "my-cover" };
  assert.deepEqual(await enrichBookmark(supplied, async () => { throw new Error("Must not upload"); }), { ...supplied, description: "Fetched summary" });
});

test("skips metadata for complete bookmarks and file attachments", async () => {
  globalThis.fetch = async () => { throw new Error("Must not fetch"); };
  const complete = { ...input, title: "My title", description: "My summary", coverFileId: "my-cover" };
  const file = { ...input, title: "File", file: { id: "file-id", name: "file.txt", mimeType: "text/plain" } };
  assert.equal(await enrichBookmark(complete, upload), complete);
  assert.equal(await enrichBookmark(file, upload), file);
});

test("metadata failure retains the URL fallback and user description", async () => {
  for (const response of [null, new Response(null, { status: 502 }), new Response("broken JSON")]) {
    globalThis.fetch = async () => { if (!response) throw new Error("Network failure"); return response; };
    const supplied = { ...input, description: "My summary" };
    assert.deepEqual(await enrichBookmark(supplied, upload), { ...supplied, title: input.url });
  }
});

test("decodes and stores the automatic cover while preserving supplied description", async () => {
  let closed = false;
  globalThis.createImageBitmap = async () => ({ close: () => { closed = true; } }) as ImageBitmap;
  globalThis.fetch = async () => Response.json({ title: "Fetched title", description: "Fetched summary", thumbnail: { data: "eA==", mimeType: "image/png" } });
  const enriched = await enrichBookmark({ ...input, description: "My summary" }, async file => {
    assert.equal(file.type, "image/png");
    assert.equal(await file.text(), "x");
    assert.equal(closed, true);
    return "cover-id";
  });
  assert.equal(enriched.coverFileId, "cover-id");
  assert.equal(enriched.description, "My summary");
});

test("invalid images and failed uploads do not prevent text enrichment", async () => {
  globalThis.fetch = async () => Response.json({ title: "Fetched title", thumbnail: { data: "eA==", mimeType: "image/png" } });
  globalThis.createImageBitmap = async () => { throw new Error("Invalid image"); };
  assert.equal((await enrichBookmark(input, upload)).title, "Fetched title");
  globalThis.createImageBitmap = async () => ({ close() {} }) as ImageBitmap;
  assert.deepEqual(await enrichBookmark(input, async () => { throw new Error("Upload failed"); }), { ...input, title: "Fetched title" });
});
