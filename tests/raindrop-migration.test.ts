import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { importedBookmark, itemAssets, rateLimitUntil } from "../src/lib/raindrop-migration-model";
import { validateBookmark } from "../src/lib/library";
import { transferAsset, validateDownloadUrl } from "../src/lib/raindrop-transfer";
import { POST } from "../src/app/api/migrate/raindrop/route";

const originalFetch = globalThis.fetch, originalGet = https.get;
afterEach(() => { globalThis.fetch = originalFetch; https.get = originalGet; });

test("file originals require uploaded bytes; metadata, long fields and alternate covers survive projection", () => {
  const source = { _id: 5, link: "https://up.raindrop.io/5/original.pdf", title: "t".repeat(1000), excerpt: "x".repeat(10000), tags: ["research"], collection: { $id: 2 }, file: { name: "original.pdf", size: 60_000_000, type: "application/pdf" }, cover: "https://example.com/cover.png", media: [{ link: "https://example.com/other.png" }], important: true, highlights: [{ text: "keep me" }], created: "original-time" };
  const assets = itemAssets(source).map((a, i) => ({ ...a, id: `asset_${i}` }));
  assert.equal(assets.length, 3);
  assert.throws(() => importedBookmark({ source, id: "bookmark", assets }, "7"), /not been uploaded/);
  const saved = importedBookmark({ source, id: "bookmark", assets: assets.map(a => ({ ...a, done: true })) }, "7");
  assert.equal(saved.file?.id, "asset_0"); assert.equal(saved.coverFileId, "asset_1");
  assert.equal(saved.url, "https://drive.google.com/file/d/asset_0/view");
  assert.equal(saved.title.length, 500); assert.equal(saved.raindrop?.item.title, source.title);
  assert.deepEqual(saved.raindrop?.item.highlights, source.highlights);
  assert.deepEqual(validateBookmark(saved), saved);
  assert.equal(itemAssets({ _id: 6, link: "https://example.com/document.pdf", collection: { $id: 2 }, type: "document" }).length, 0);
});

test("rate waits honor both Retry-After variants and server reset, and private source URLs are rejected", () => {
  const now = 1700000000000;
  assert.equal(rateLimitUntil(new Headers({ "Retry-After": "12" }), now), now + 12000);
  assert.equal(rateLimitUntil(new Headers({ "Retry-After": new Date(now + 20000).toUTCString() }), now), now + 20000);
  assert.equal(rateLimitUntil(new Headers({ "x-ratelimit-reset": String((now + 60000) / 1000) }), now), now + 61000);
  for (const url of ["http://127.0.0.1/x", "http://10.2.3.4/x", "http://[::1]/x", "file:///secret", "https://token@example.com/x", "http://example.com:8000/x"]) assert.throws(() => validateDownloadUrl(url));
});

test("migration endpoint rejects cross-origin requests, arbitrary proxy paths, and invalid tokens", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("unexpected external request"); };
  const req = (body: unknown, origin = "http://localhost:3000") => new Request("http://localhost:3000/api/migrate/raindrop", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Authorization: "Bearer google-token" }, body: JSON.stringify(body) });
  assert.equal((await POST(req({}, "https://evil.example"))).status, 403);
  await POST(req({ action: "source", resource: "http://private", token: "rd-token" }));
  await POST(req({ action: "source", resource: "user", token: "bad token" }));
  assert.equal(calls, 0);
});

test("51 MiB original is downloaded to disk, uploaded in chunks, checksum verified, and ambiguous final PUT reconciled", async () => {
  const chunk = Buffer.alloc(1024 * 1024, 0x72), count = 51, total = chunk.length * count;
  const expected = createHash("md5"); for (let i = 0; i < count; i++) expected.update(chunk);
  const digest = expected.digest("hex");
  let credential = "", offset = 0, committed = false, puts = 0, downloads = 0;
  const uploaded = createHash("md5");
  https.get = ((_url: unknown, options: { headers: Record<string, string> }, callback: (response: unknown) => void) => {
    downloads++; credential = options.headers.Authorization;
    const response = Readable.from(Array.from({ length: count }, () => chunk)) as Readable & { headers: unknown; statusCode: number };
    response.headers = { "content-type": "application/pdf", "content-length": String(total) }; response.statusCode = 200;
    queueMicrotask(() => callback(response));
    return new EventEmitter();
  }) as typeof https.get;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("files/assets")) return Response.json({ id: "assets", appProperties: { app: "rainbow", kind: "assets", library: "root" } });
    if (String(url).includes("files/original")) return committed ? Response.json({ id: "original", size: String(total), md5Checksum: digest, mimeType: "application/pdf", parents: ["assets"], appProperties: { app: "rainbow", kind: "asset", library: "root", checksum: digest, source: createHash("sha256").update("https://up.raindrop.io/5/file.pdf").digest("hex") } }) : new Response(null, { status: 404 });
    if (String(url).includes("uploadType=resumable")) return new Response(null, { status: 200, headers: { Location: "https://www.googleapis.com/session" } });
    assert.equal(String(url), "https://www.googleapis.com/session");
    const range = new Headers(init?.headers).get("content-range");
    if (range === `bytes */${total}`) { assert.equal(committed, true); return Response.json({ id: "original" }); }
    const body = init?.body as Buffer; assert.ok(body.length <= 8 * 1024 * 1024);
    assert.equal(range, `bytes ${offset}-${offset + body.length - 1}/${total}`);
    uploaded.update(body); offset += body.length; puts++;
    if (offset === total) { committed = true; throw new Error("final response lost"); }
    return new Response(null, { status: 308, headers: { Range: `bytes=0-${offset - 1}` } });
  };
  const events: { done?: boolean; bytes?: number }[] = [];
  await transferAsset({ id: "original", url: "https://up.raindrop.io/5/file.pdf", name: "file.pdf", image: false, size: total }, "assets", "google-token", "raindrop-token", e => events.push(e), new AbortController().signal);
  assert.equal(credential, "Bearer raindrop-token"); assert.equal(puts, 7);
  assert.equal(uploaded.digest("hex"), digest); assert.equal(events.at(-1)?.done, true);
  assert.equal(events.at(-1)?.bytes, total);
  await transferAsset({ id: "original", url: "https://up.raindrop.io/5/file.pdf", name: "file.pdf", image: false, size: total }, "assets", "google-token", "raindrop-token", () => {}, new AbortController().signal);
  assert.equal(downloads, 1); assert.equal(puts, 7); // Reopen reconciles the committed ID without another download or upload.
});

test("migration resumes Drive checkpoints, preserves nested/shared collections and same-URL items, continues file failures, and retries without duplicates", async () => {
  const { RaindropMigration } = await import("../src/lib/raindrop-migration");
  const oldWindow = globalThis.window, oldStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => JSON.stringify({ accessToken: "google-token", refreshToken: "refresh", expiresAt: Date.now() + 3600000, accountId: "owner", email: "a@example.com", name: "A" }) } });
  try {
    const library = { rootId: "root", assetsId: "assets", unsortedId: "unsorted", collections: [], bookmarks: [], syncedAt: "" };
    const checkpoints = new Map<string, { meta: Record<string, unknown>; data: unknown }>();
    const bookmarks = new Map<string, Record<string, unknown>>(), collections = new Map<string, Record<string, unknown>>();
    let allocated = 0, firstFile = true, firstIcon = true, firstCover = true, lostBookmark = true, paused = false;
    const attempts: string[] = [];
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u === "/api/migrate/raindrop") {
        const b = JSON.parse(String(init?.body));
        if (b.action === "source") {
          if (b.resource === "user") return Response.json({ user: { _id: 7 } });
          if (b.resource === "collections") return Response.json({ items: [{ _id: 10, title: "Shared", access: { level: 2 }, sort: 10, cover: ["https://example.com/icon.png"] }] });
          if (b.resource === "children") return Response.json({ items: [{ _id: 11, title: "Nested", parent: { $id: 10 } }] });
          const source = (id: number, c: number) => ({ _id: id, link: "https://example.com/same", title: `Item ${id}`, collection: { $id: c }, ...(id === 2 ? { cover: "https://example.com/cover.png" } : {}) });
          if (b.collectionId === 10 && b.page === 0) return Response.json({ items: Array.from({ length: 50 }, (_, i) => source(i + 1, 10)) });
          if (b.collectionId === 10 && b.page === 1) return Response.json({ items: [{ ...source(51, 10), link: "https://up.raindrop.io/file.pdf", file: { name: "original.pdf", type: "application/pdf", size: 60_000_000 } }] });
          if (b.collectionId === 11) return Response.json({ items: [source(100, 11)] });
          return Response.json({ items: [] });
        }
        if (b.action === "collection") { collections.set(b.folder, b.data); return Response.json({ id: b.folder }); }
        if (b.action === "asset") {
          if (b.asset.image) {
            if (b.asset.name.includes("-cover")) {
              if (firstCover) { firstCover = false; return new Response(JSON.stringify({ error: "cover unavailable" }) + "\n"); }
              return new Response(JSON.stringify({ phase: "Uploaded", done: true, mimeType: "image/png" }) + "\n");
            }
            if (firstIcon) { firstIcon = false; return new Response(JSON.stringify({ error: "icon unavailable" }) + "\n"); }
            return new Response(JSON.stringify({ phase: "Uploaded", done: true, mimeType: "image/png" }) + "\n");
          }
          if (firstFile) { firstFile = false; return new Response(JSON.stringify({ error: "file unavailable" }) + "\n"); }
          return new Response(JSON.stringify({ phase: "Uploaded", done: true, mimeType: "application/pdf" }) + "\n");
        }
        if (b.action === "bookmark") {
          attempts.push(b.id); bookmarks.set(b.id, b.data);
          if (lostBookmark) { lostBookmark = false; throw new Error("response lost"); }
          return Response.json({ id: b.id });
        }
        throw new Error(`Unknown action ${b.action}`);
      }
      const parsed = new URL(u);
      if (parsed.pathname.endsWith("generateIds")) return Response.json({ ids: Array.from({ length: Number(parsed.searchParams.get("count")) }, () => `generated_${++allocated}`) });
      if (init?.method === "POST" || init?.method === "PATCH") {
        const parts = String(init.body).split(/\r\n\r\n/);
        const meta = JSON.parse(parts[1].split("\r\n--")[0]);
        const data = JSON.parse(parts[2].split("\r\n--")[0]);
        const id = meta.id || parsed.pathname.split("/").at(-1)!;
        checkpoints.set(id, { meta: { ...meta, id, parents: ["root"], modifiedTime: String(Date.now()), version: "1" }, data });
        return Response.json(checkpoints.get(id)!.meta);
      }
      if (parsed.searchParams.has("q")) return Response.json({ files: [...checkpoints].filter(([, f]) => (f.meta.appProperties as { kind: string }).kind === "migration").map(([id]) => ({ id })) });
      const id = parsed.pathname.split("/").at(-1)!;
      const stored = checkpoints.get(id);
      if (!stored) return new Response(null, { status: 404 });
      return Response.json(parsed.searchParams.get("alt") === "media" ? stored.data : stored.meta);
    };
    const options = { ownerId: "owner", library, token: "rd-secret-token", paused: () => paused, progress: (p: { bookmarks: number }) => { if (p.bookmarks === 1) paused = true; } };
    const first = await new RaindropMigration(options).run();
    assert.equal(first.migration?.status, "paused"); assert.equal(bookmarks.size, 1);
    assert.equal(first.migration?.collections.find(c => c.source._id === 10)?.created, true);
    assert.match(first.failures[0], /icon unavailable/); // An unavailable icon does not block the folder, child, or links.
    paused = false;
    const second = await new RaindropMigration({ ...options, progress: () => {} }).run();
    assert.equal(second.migration?.status, "incomplete"); assert.equal(second.failures.length, 2);
    assert.equal(bookmarks.size, 51); // The nested item succeeds after the original-file failure.
    const third = await new RaindropMigration({ ...options, progress: () => {} }).run();
    assert.equal(third.migration?.status, "complete"); assert.equal(third.failures.length, 0); assert.equal(bookmarks.size, 52);
    assert.equal(collections.size, 3); // Source Unsorted is separate from existing Rainbow Unsorted.
    const root = [...collections].find(([, c]) => c.name === "Shared")!;
    assert.equal([...collections.values()].find(c => c.name === "Nested")?.parentId, root[0]);
    assert.equal([...bookmarks.values()].filter(b => b.url === "https://example.com/same").length, 51);
    assert.equal(attempts.length, 54); assert.equal(attempts[0], attempts[1]);
    assert.equal(JSON.stringify([...checkpoints.values()]).includes("rd-secret-token"), false);
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: oldWindow });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: oldStorage });
  }
});

test("retry fills a missing cover in the existing bookmark without overwriting edited text", async () => {
  const origin = { accountId: "7", item: { _id: 2 }, assets: [] as { id: string; url: string }[] };
  const saved = { schemaVersion: 1, title: "My edited title", description: "My description", note: "My notes", tags: ["mine"], url: "https://example.com/", raindrop: origin };
  let update = "";
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("files/collection")) return Response.json({ id: "collection", mimeType: "application/vnd.google-apps.folder", parents: ["root"], appProperties: { app: "rainbow", kind: "collection", library: "root" } });
    if (init?.method === "PATCH") {
      assert.equal(new Headers(init.headers).get("If-Match"), '"current"');
      update = String(init.body); return Response.json({ id: "imported", modifiedTime: "new", version: "2" });
    }
    if (u.includes("alt=media")) return Response.json(saved);
    return Response.json({ id: "imported", name: "My edited title.json", parents: ["collection"], modifiedTime: "old", appProperties: { app: "rainbow", kind: "bookmark", library: "root" } }, { headers: { ETag: '"current"' } });
  };
  const request = new Request("http://localhost:3000/api/migrate/raindrop", { method: "POST", headers: { Origin: "http://localhost:3000", "Content-Type": "application/json", Authorization: "Bearer google" }, body: JSON.stringify({ action: "bookmark", id: "imported", parentId: "collection", data: { ...saved, title: "Original source title", note: "Source notes", coverFileId: "cover", raindrop: { ...origin, assets: [{ id: "cover", url: "https://example.com/cover.png" }] } } }) });
  assert.equal((await POST(request)).status, 200);
  assert.match(update, /My edited title/); assert.match(update, /My notes/); assert.match(update, /"coverFileId":"cover"/);
  assert.doesNotMatch(update, /Original source title/);
});
