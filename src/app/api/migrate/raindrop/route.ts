import { createHash } from "node:crypto";
import { readMutationBody } from "@/lib/mutation-request";
import { serverRequest } from "@/lib/create-bookmark-server";
import { DriveError, metadata, parentRoot, saveCollection, writeJson } from "@/lib/drive";
import { validateBookmark, validateCollection, validateId } from "@/lib/library";
import { transferAsset, validateDownloadUrl } from "@/lib/raindrop-transfer";
import type { AssetPlan } from "@/lib/raindrop-migration-model";
import type { Collection, CollectionInput } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 900;
// Client pacing persists across requests; this guards overlapping requests on this server too.
const recent = new Map<string, number>();
export async function POST(request: Request): Promise<Response> {
  if (request.headers.get("origin") !== new URL(request.url).origin || !request.headers.get("content-type")?.startsWith("application/json")) return Response.json({ error: "Invalid request." }, { status: 403 });
  const token = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/)?.[1];
  if (!token || token.length > 8192) return Response.json({ error: "Connect Google Drive." }, { status: 401 });
  try {
    const b = await readMutationBody(request) as Record<string, unknown>;
    if (b.action === "source") {
      const rt = sourceToken(b.token);
      let path: string;
      if (b.resource === "user") path = "user";
      else if (b.resource === "collections") path = "collections";
      else if (b.resource === "children") path = "collections/childrens";
      else if (b.resource === "items" && Number.isSafeInteger(b.collectionId) && (Number(b.collectionId) > 0 || b.collectionId === -1) && Number.isSafeInteger(b.page) && Number(b.page) >= 0) path = `raindrops/${b.collectionId}?page=${b.page}&perpage=50&nested=false&sort=created`;
      else throw new Error("Invalid Raindrop resource.");
      const key = createHash("sha256").update(rt).digest("hex"), now = Date.now(), until = recent.get(key) || 0;
      if (until > now) return Response.json({ error: "Waiting for Raindrop’s rate limit." }, { status: 429, headers: { "Retry-After": String(Math.ceil((until - now) / 1000)) } });
      for (const [id, time] of recent) if (time < now - 60000) recent.delete(id);
      recent.set(key, now + 700);
      const result = await fetch(`https://api.raindrop.io/rest/v1/${path}`, { headers: { Authorization: `Bearer ${rt}` }, cache: "no-store", signal: AbortSignal.timeout(30000) });
      const headers = new Headers({ "Cache-Control": "no-store" });
      for (const name of ["retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"]) {
        const value = result.headers.get(name) ?? result.headers.get(name.replace(/^x-/, ""));
        if (value) headers.set(name, value);
      }
      if ([401, 403].includes(result.status)) return Response.json({ error: "Raindrop rejected this token. Enter a valid token with access to your collections.", raindropAuth: true }, { status: 422, headers });
      if (!result.ok) return Response.json({ error: `Raindrop request failed (${result.status}).` }, { status: result.status === 429 ? 429 : 502, headers });
      const data = await result.json();
      if (data.result === false) return Response.json({ error: "Raindrop could not read this resource." }, { status: 502, headers });
      return Response.json(data, { headers });
    }
    if (b.action === "asset") {
      const rt = sourceToken(b.token), a = b.asset as AssetPlan;
      if (!a || typeof a.name !== "string" || !a.name || a.name.length > 1000 || typeof a.image !== "boolean" || (a.size !== undefined && (!Number.isSafeInteger(a.size) || a.size < 0))) throw new Error("Invalid asset.");
      validateId(a.id); validateDownloadUrl(a.url); validateId(b.assetsId);
      const encoder = new TextEncoder();
      const abort = new AbortController();
      const stream = new ReadableStream({
        start(controller) {
          const emit = (event: unknown) => { if (!abort.signal.aborted) controller.enqueue(encoder.encode(JSON.stringify(event) + "\n")); };
          const heartbeat = setInterval(() => emit({ phase: "Transferring file" }), 10000);
          void transferAsset(a, String(b.assetsId), token, rt, emit, AbortSignal.any([abort.signal, request.signal, AbortSignal.timeout(850000)]))
            .catch(error => emit({ error: error instanceof DriveError ? error.message : "Could not transfer this asset. Check the source file, connection, and server disk capacity, then retry.", googleAuth: error instanceof DriveError && error.status === 401 }))
            .finally(() => { clearInterval(heartbeat); if (!abort.signal.aborted) controller.close(); });
        },
        cancel() { abort.abort(); },
      });
      return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
    }
    const drive = serverRequest(token);
    if (b.action === "collection") {
      const data = validateCollection(b.data as CollectionInput), folderId = validateId(b.folder), configId = validateId(b.config);
      const root = await parentRoot(data.parentId, drive);
      let existing: Collection | undefined;
      try {
        const folder = await metadata(folderId, drive);
        if (folder.trashed || folder.appProperties?.app !== "rainbow" || folder.appProperties.kind !== "collection" || folder.appProperties.library !== root || !folder.parents?.includes(data.parentId)) throw new Error("Invalid imported collection reference.");
        existing = { ...data, id: folderId, modifiedTime: folder.modifiedTime };
        try {
          const config = await metadata(configId, drive);
          if (config.trashed || config.appProperties?.kind !== "config" || config.appProperties?.library !== root || !config.parents?.includes(folderId)) throw new Error("Invalid imported collection settings.");
          existing.configId = configId; existing.configModifiedTime = config.modifiedTime;
        } catch (e) { if (!(e instanceof DriveError) || e.status !== 404) throw e; }
      } catch (e) { if (!(e instanceof DriveError) || e.status !== 404) throw e; }
      return Response.json(await saveCollection(data, existing, drive, { folder: folderId, config: configId }));
    }
    if (b.action === "bookmark") {
      const data = validateBookmark(b.data), parentId = validateId(b.parentId), id = validateId(b.id);
      if (!data.raindrop || !Number.isSafeInteger(data.raindrop.item._id) || Number(data.raindrop.item._id) <= 0) throw new Error("Missing source bookmark identity.");
      const root = await parentRoot(parentId, drive);
      try {
        const existing = await metadata(id, drive);
        if (existing.trashed || existing.appProperties?.app !== "rainbow" || existing.appProperties.kind !== "bookmark" || existing.appProperties.library !== root || !existing.parents?.includes(parentId)) throw new Error("Invalid imported bookmark reference.");
        const saved = validateBookmark(await (await drive(`files/${id}?alt=media`)).json());
        if (saved.raindrop?.accountId !== data.raindrop?.accountId || saved.raindrop?.item._id !== data.raindrop?.item._id) throw new Error("Imported bookmark ID conflicts with another item.");
        // Retry fills missing assets while retaining any edits made to the imported text.
        const updated = validateBookmark({ ...saved, ...(data.file ? { file: data.file } : {}), ...(data.coverFileId ? { coverFileId: data.coverFileId } : {}), raindrop: data.raindrop });
        if (JSON.stringify(updated) !== JSON.stringify(saved)) await writeJson(`${updated.title}.json`, updated, "bookmark", parentId, root, existing, undefined, drive);
        return Response.json({ id });
      } catch (e) { if (!(e instanceof DriveError) || e.status !== 404) throw e; }
      try { await writeJson(`${data.title}.json`, data, "bookmark", parentId, root, undefined, undefined, drive, id); }
      catch (e) {
        if (!(e instanceof DriveError) || e.status !== 409) throw e;
        const saved = validateBookmark(await (await drive(`files/${id}?alt=media`)).json());
        if (JSON.stringify(saved) !== JSON.stringify(data)) throw new Error("Imported bookmark could not be confirmed.");
      }
      return Response.json({ id });
    }
    return Response.json({ error: "Unknown migration operation." }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof DriveError ? error.message : "Migration operation failed. Check the source data and retry." }, { status: error instanceof DriveError && error.status === 401 ? 401 : 502 });
  }
}
function sourceToken(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 8192 || /\s/.test(value)) throw new Error("Invalid Raindrop token.");
  return value;
}
