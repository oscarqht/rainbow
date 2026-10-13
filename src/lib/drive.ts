import { getAccessToken } from "./auth-client";
import { validateBookmark, validateCollection, validateId, validateFile } from "./library";
import type { Bookmark, BookmarkData, Collection, CollectionInput, Library } from "./types";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER = "application/vnd.google-apps.folder";
const FIELDS = "id,name,mimeType,parents,modifiedTime,version,appProperties,trashed";
type DriveFile = { id: string; name: string; mimeType: string; parents?: string[]; modifiedTime: string; version: string; appProperties?: Record<string, string>; trashed?: boolean; etag?: string };
export class DriveError extends Error { constructor(message: string, public status: number) { super(message); } }
export class BookmarkTrashError extends Error { readonly bookmarkDeleted = true; }
export class ConflictError extends Error { constructor() { super("This item changed in another browser or in Drive. Refresh before saving; your draft has been kept."); } }

const RATE_LIMITS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "RATE_LIMIT_EXCEEDED"]);
async function errorReason(response: Response): Promise<string> {
  try {
    const body = await response.clone().json() as { error?: { errors?: { reason?: string }[]; details?: { reason?: string }[] } };
    return body.error?.details?.find(d => d.reason)?.reason ?? body.error?.errors?.[0]?.reason ?? "";
  } catch { return ""; }
}
function forbiddenMessage(reason: string): string {
  if (reason === "accessNotConfigured" || reason === "SERVICE_DISABLED") return "The Google Drive API is not enabled for this app's Google Cloud project. Enable it in Google Cloud Console (APIs & Services → Library → Google Drive API), wait a minute, then retry.";
  if (reason === "insufficientPermissions" || reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT") return "Rainbow was not granted Google Drive access. Disconnect and connect again, allowing Drive access.";
  if (RATE_LIMITS.has(reason) || reason === "quotaExceeded" || reason === "storageQuotaExceeded") return "Google Drive quota or rate limit reached. Wait a moment and retry.";
  return `Check Drive permissions and quota${reason ? ` (${reason})` : ""}.`;
}

export async function driveRequest(path: string, init: RequestInit = {}, upload = false): Promise<Response> {
  const read = !init.method || init.method === "GET";
  let renewed = false;
  let token = await getAccessToken();
  for (let attempt = 0; ; attempt++) {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    let response: Response;
    try { response = await fetch(`${upload ? UPLOAD : API}/${path}`, { ...init, headers, cache: "no-store" }); }
    catch { throw new DriveError("Cannot reach Google Drive. Check your connection and retry. Your changes have not been discarded.", 0); }
    if (response.status === 401 && !renewed) { renewed = true; token = await getAccessToken(true); continue; }
    const reason = response.status === 403 ? await errorReason(response) : "";
    if (read && (response.status === 429 || response.status >= 500 || RATE_LIMITS.has(reason)) && attempt < 3) {
      const seconds = Number(response.headers.get("Retry-After"));
      await new Promise(resolve => setTimeout(resolve, Math.min(10000, seconds > 0 ? seconds * 1000 : 500 * 2 ** attempt)));
      continue;
    }
    if (response.status === 412) throw new ConflictError();
    if (!response.ok) throw new DriveError(`Google Drive request failed (${response.status}). ${response.status === 403 ? forbiddenMessage(reason) : "Retry or reconnect Google if access was revoked."}`, response.status);
    return response;
  }
}
export async function metadata(id: string, request = driveRequest): Promise<DriveFile> {
  const response = await request(`files/${validateId(id)}?fields=${FIELDS}`);
  return { ...await response.json(), etag: response.headers.get("ETag") || undefined };
}
async function list(q: string): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let page: string | undefined;
  do {
    const params = new URLSearchParams({ q, fields: `nextPageToken,files(${FIELDS})`, pageSize: "1000", spaces: "drive" });
    if (page) params.set("pageToken", page);
    const data = await (await driveRequest(`files?${params}`)).json();
    files.push(...data.files);
    page = data.nextPageToken;
  } while (page);
  return files;
}
const marker = "appProperties has { key='app' and value='rainbow' }";
const properties = (kind: string, library?: string) => ({ app: "rainbow", kind, ...(library ? { library } : {}) });
async function createFolder(name: string, kind: string, parent?: string, root?: string, request = driveRequest, id?: string): Promise<DriveFile> {
  try { return (await request(`files?fields=${FIELDS}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...(id ? { id } : {}), name, mimeType: FOLDER, ...(parent ? { parents: [parent] } : {}), appProperties: properties(kind, root) }) })).json(); }
  catch (error) {
    if (id && error instanceof DriveError && error.status === 409) return metadata(id, request);
    throw error;
  }
}
async function root(): Promise<DriveFile> {
  const roots = await list(`trashed=false and ${marker} and appProperties has { key='kind' and value='root' }`);
  if (roots.length > 1) throw new Error("Multiple Rainbow library roots found in Drive. Keep one active root and trash the duplicate before reconnecting.");
  return roots[0] || createFolder("Rainbow", "root");
}
async function changeToken(): Promise<string> {
  return (await (await driveRequest("changes/startPageToken?fields=startPageToken")).json()).startPageToken;
}
async function changes(token: string): Promise<{ changed: boolean; token: string }> {
  let page: string | undefined = token, result = token, changed = false;
  do {
    const params: URLSearchParams = new URLSearchParams({ pageToken: page, fields: "nextPageToken,newStartPageToken,changes(fileId,removed)", pageSize: "1000", spaces: "drive" });
    const data: {changes: {fileId: string}[]; nextPageToken?: string; newStartPageToken?: string} = await (await driveRequest(`changes?${params}`)).json();
    changed ||= data.changes.length > 0;
    result = data.newStartPageToken || result;
    page = data.nextPageToken;
  } while (page);
  return { changed, token: result };
}
async function jsonFile(file: DriveFile): Promise<unknown> {
  const response = await driveRequest(`files/${validateId(file.id)}?alt=media`);
  try { return await response.json(); } catch { throw new Error(`“${file.name}” contains invalid JSON. Repair or restore this file in Drive, then retry sync.`); }
}
async function mapLimit<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (index < items.length) { const i = index++; results[i] = await fn(items[i]); }
  }));
  return results;
}
export async function loadLibrary(previous?: Library): Promise<Library> {
  let token: string;
  if (previous?.changeToken) {
    try {
      const delta = await changes(previous.changeToken);
      if (!delta.changed) return { ...previous, changeToken: delta.token, syncedAt: new Date().toISOString() };
      token = delta.token;
    } catch (error) {
      if (!(error instanceof DriveError) || error.status !== 410) throw error;
      token = await changeToken();
    }
  } else token = await changeToken();
  const libraryRoot = await root();
  let files = await list(`trashed=false and ${marker} and appProperties has { key='library' and value='${libraryRoot.id}' }`);
  const assets = files.find(f => f.appProperties?.kind === "assets" && f.parents?.includes(libraryRoot.id)) || await createFolder("_assets", "assets", libraryRoot.id, libraryRoot.id);
  const unsorted = files.find(f => f.appProperties?.kind === "collection" && f.appProperties?.system === "unsorted" && f.parents?.includes(libraryRoot.id));
  let unsortedFile = unsorted;
  if (!unsortedFile) {
    unsortedFile = await createFolder("Unsorted", "collection", libraryRoot.id, libraryRoot.id);
    await driveRequest(`files/${unsortedFile.id}?fields=${FIELDS}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ appProperties: { ...properties("collection", libraryRoot.id), system: "unsorted" } }) });
    files = [...files, { ...unsortedFile, appProperties: { ...unsortedFile.appProperties, system: "unsorted" } }];
  }
  const reachable = new Set([libraryRoot.id]);
  const folders = files.filter(f => f.mimeType === FOLDER && f.appProperties?.kind === "collection");
  let expanded = true;
  while (expanded) { expanded = false; for (const f of folders) if (!reachable.has(f.id) && f.parents?.some(p => reachable.has(p))) { reachable.add(f.id); expanded = true; } }
  const collections = await mapLimit(folders.filter(f => reachable.has(f.id)), async f => {
    const config = files.find(c => c.appProperties?.kind === "config" && c.parents?.includes(f.id));
    let settings: Partial<CollectionInput> = {};
    if (config) {
      const raw = await jsonFile(config) as CollectionInput;
      settings = validateCollection({ ...raw, name: f.name, parentId: f.parents![0] });
    }
    return { id: f.id, name: f.name, parentId: f.parents![0], order: settings.order ?? 0, view: settings.view ?? "grid", iconFileId: settings.iconFileId, color: settings.color, version: f.version, modifiedTime: f.modifiedTime, configId: config?.id, configVersion: config?.version, configModifiedTime: config?.modifiedTime, ...(f.id === unsortedFile!.id ? { system: "unsorted" as const } : {}) };
  });
  const cached = new Map(previous?.bookmarks.map(b => [b.id, b]));
  const bookmarks = await mapLimit(files.filter(f => f.appProperties?.kind === "bookmark" && f.parents?.some(p => reachable.has(p))), async f => {
    const old = cached.get(f.id);
    if (old?.version === f.version) return { ...old, parentId: f.parents![0] };
    let data: BookmarkData;
    try { data = validateBookmark(await jsonFile(f)); } catch (error) { throw new Error(`Cannot read “${f.name}”: ${(error as Error).message}`); }
    return { ...data, id: f.id, parentId: f.parents![0], version: f.version, modifiedTime: f.modifiedTime };
  });
  return { rootId: libraryRoot.id, assetsId: assets.id, unsortedId: unsortedFile.id, collections, bookmarks, changeToken: token, syncedAt: new Date().toISOString() };
}
export async function parentRoot(parentId: string, request = driveRequest): Promise<string> {
  const p = await metadata(parentId, request);
  if (p.trashed || p.mimeType !== FOLDER || p.appProperties?.app !== "rainbow" || !["root", "collection"].includes(p.appProperties.kind)) throw new Error("Choose a valid Rainbow collection.");
  const library = p.appProperties.kind === "root" ? p.id : validateId(p.appProperties.library);
  let ancestor = p;
  const visited = new Set<string>();
  while (ancestor.id !== library) {
    if (visited.has(ancestor.id) || !ancestor.parents?.[0]) throw new Error("This collection is outside the Rainbow library. Move it back in Drive before saving.");
    visited.add(ancestor.id);
    if (ancestor.parents[0] === library) break;
    ancestor = await metadata(ancestor.parents[0], request);
    if (ancestor.trashed || ancestor.appProperties?.app !== "rainbow" || ancestor.appProperties?.library !== library || ancestor.appProperties?.kind !== "collection") throw new Error("This collection is outside the Rainbow library. Move it back in Drive before saving.");
  }
  return library;
}
// Compare modifiedTime, not version: Drive bumps `version` for server-side processing
// (e.g. generating the thumbnail from contentHints), which would report false conflicts.
async function assertUnchanged(id: string, modifiedTime?: string, request = driveRequest): Promise<DriveFile> {
  const latest = await metadata(id, request);
  if (latest.trashed || (modifiedTime && latest.modifiedTime !== modifiedTime)) throw new ConflictError();
  return latest;
}
async function thumbnail(fileId: string): Promise<{ image: string; mimeType: string }> {
  const blob = await readImage(fileId);
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, 800 / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.max(220, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) { bitmap.close(); throw new Error("Cannot generate a cover thumbnail in this browser."); }
  ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
  return { image: canvas.toDataURL("image/jpeg", .8).split(",")[1].replace(/\+/g, "-").replace(/\//g, "_"), mimeType: "image/jpeg" };
}
export type Hints = { thumbnail: { image: string; mimeType: string } };
export async function writeJson(name: string, data: unknown, kind: string, parentId: string, library: string, existing?: DriveFile, hints?: Hints, request = driveRequest, createId?: string): Promise<DriveFile> {
  const meta = { ...(createId ? { id: createId } : {}), name, mimeType: "application/json", appProperties: properties(kind, library), ...(!existing ? { parents: [parentId] } : {}), ...(hints ? { contentHints: hints } : {}) };
  const boundary = `rainbow_${crypto.randomUUID()}`;
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(data)}\r\n--${boundary}--`;
  const params = new URLSearchParams({ uploadType: "multipart", fields: FIELDS });
  if (existing && !existing.parents?.includes(parentId)) {
    params.set("addParents", parentId);
    if (existing.parents?.length) params.set("removeParents", existing.parents.join(","));
  }
  const response = await request(`files${existing ? `/${existing.id}` : ""}?${params}`, { method: existing ? "PATCH" : "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}`, ...(existing?.etag ? { "If-Match": existing.etag } : {}) }, body }, true);
  return { ...await response.json(), etag: response.headers.get("ETag") || undefined };
}
// Thumbnail decoding stays in the browser; bookmark writes run on the server.
async function bookmarkHints(input: BookmarkData): Promise<Hints | undefined> {
  if (!input.coverFileId) return;
  try { return { thumbnail: await thumbnail(input.coverFileId) }; }
  catch (error) {
    // Some image attachments cannot be decoded by canvas; keep the original cover.
    if (input.coverFileId !== input.file?.id) throw error;
  }
}
export async function createBookmark(input: BookmarkData, parentId: string): Promise<Bookmark> {
  return mutationRequest("/api/bookmarks", "POST", { data: input, parentId, hints: await bookmarkHints(input) });
}
export async function editBookmark(input: BookmarkData, parentId: string, existing: Bookmark): Promise<Bookmark> {
  return mutationRequest("/api/bookmarks", "PATCH", { data: input, parentId, existing, hints: await bookmarkHints(input) });
}
export async function deleteBookmark(bookmark: Bookmark): Promise<void> {
  await mutationRequest("/api/bookmarks", "DELETE", { existing: bookmark });
}
async function mutationRequest<T>(path: string, method: string, body: unknown): Promise<T> {
  let token = await getAccessToken();
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(path, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    if (response.status === 401 && attempt === 0) { token = await getAccessToken(true); continue; }
    const result = await response.json();
    if (!response.ok) {
      const message = result.error || "Couldn’t update this bookmark in Drive. Please try again.";
      if (result.bookmarkDeleted) throw new BookmarkTrashError(message);
      throw new Error(message);
    }
    return result;
  }
}

export async function saveBookmark(input: BookmarkData, parentId: string, existing?: Bookmark): Promise<Bookmark> {
  const data = validateBookmark(input), library = await parentRoot(parentId);
  const hints = await bookmarkHints(data);
  const latest = existing ? await assertUnchanged(existing.id, existing.modifiedTime) : undefined;
  if (latest && (latest.appProperties?.library !== library || latest.appProperties?.kind !== "bookmark")) throw new Error("Invalid bookmark reference.");
  const file = await writeJson(`${data.title}.json`, data, "bookmark", parentId, library, latest, hints);
  return { ...data, id: file.id, parentId, modifiedTime: file.modifiedTime, version: file.version, etag: file.etag };
}
export async function saveCollectionInBackground(input: CollectionInput, existing?: Collection): Promise<Collection> {
  return mutationRequest("/api/collections", existing ? "PATCH" : "POST", { data: input, existing });
}
export async function deleteCollection(collection: Collection): Promise<void> {
  await mutationRequest("/api/collections", "DELETE", { existing: collection });
}
export async function saveCollection(input: CollectionInput, existing?: Collection, request = driveRequest, createIds?: { folder: string; config: string }): Promise<Collection> {
  const data = validateCollection(input), library = await parentRoot(data.parentId, request);
  let folder: DriveFile;
  let config: DriveFile | undefined;
  if (existing) {
    if (existing.id === data.parentId) throw new Error("A collection cannot contain itself.");
    let ancestor = data.parentId;
    const visited = new Set<string>();
    while (ancestor !== library) {
      if (ancestor === existing.id || visited.has(ancestor)) throw new Error("A collection cannot move into one of its descendants.");
      visited.add(ancestor); const p = await metadata(ancestor, request); ancestor = p.parents?.[0] || library;
    }
    const latest = await assertUnchanged(existing.id, existing.modifiedTime, request);
    if (latest.appProperties?.library !== library || latest.appProperties?.kind !== "collection") throw new Error("Invalid collection reference.");
    if (latest.appProperties?.system === "unsorted" && (data.parentId !== library || data.name !== latest.name)) throw new Error("Unsorted must stay at the library root.");
    if (existing.configId) {
      config = await assertUnchanged(existing.configId, existing.configModifiedTime, request);
      if (config.appProperties?.app !== "rainbow" || config.appProperties?.kind !== "config" || config.appProperties?.library !== library || !config.parents?.includes(existing.id)) throw new Error("Invalid collection settings reference.");
    }
    const params = new URLSearchParams({ fields: FIELDS });
    if (!latest.parents?.includes(data.parentId)) { params.set("addParents", data.parentId); params.set("removeParents", latest.parents?.join(",") || ""); }
    try { folder = await (await request(`files/${existing.id}?${params}`, { method: "PATCH", headers: { "Content-Type": "application/json", ...(latest.etag ? { "If-Match": latest.etag } : {}) }, body: JSON.stringify({ name: data.name }) })).json(); }
    catch (error) {
      if (request === driveRequest) throw error;
      const saved = await metadata(existing.id, request);
      if (saved.trashed || saved.name !== data.name || !saved.parents?.includes(data.parentId)) throw error;
      folder = saved;
    }
  } else folder = await createFolder(data.name, "collection", data.parentId, library, request, createIds?.folder);
  let written: DriveFile;
  try { written = await writeJson("_collection.json", data, "config", folder.id, library, config, undefined, request, config ? undefined : createIds?.config); }
  catch (error) {
    const id = config?.id ?? createIds?.config;
    if (request === driveRequest || !id) throw error;
    // A retry may hit 409/412 after the first settings write actually committed.
    try {
      const saved = await metadata(id, request);
      const raw = await (await request(`files/${validateId(id)}?alt=media`)).json();
      if (saved.trashed || JSON.stringify(validateCollection(raw)) !== JSON.stringify(data)) throw error;
      written = saved;
    } catch {
      // The folder write already completed. Do not replay a whole create on 401;
      // let the client refresh the two-file result before another save.
      throw new Error("The collection settings could not be confirmed. Refresh your library before trying again.", { cause: error });
    }
  }
  return { ...data, id: folder.id, version: folder.version, modifiedTime: folder.modifiedTime, configId: written.id, configVersion: written.version, configModifiedTime: written.modifiedTime, system: folder.appProperties?.system === "unsorted" ? "unsorted" : existing?.system };
}
async function trash(item: { id: string; modifiedTime?: string }, allowTrashed = false, request = driveRequest): Promise<void> {
  const latest = await metadata(item.id, request);
  if (latest.trashed && allowTrashed) return;
  if (latest.trashed || (item.modifiedTime && latest.modifiedTime !== item.modifiedTime)) throw new ConflictError();
  try {
    await request(`files/${validateId(item.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json", ...(latest.etag ? { "If-Match": latest.etag } : {}) }, body: JSON.stringify({ trashed: true }) });
  } catch (error) {
    // A retry after a lost response can fail its original If-Match condition.
    if (request !== driveRequest && (await metadata(item.id, request)).trashed) return;
    throw error;
  }
}
export async function trashBookmark(bookmark: Bookmark, request = driveRequest): Promise<void> {
  // Allow retrying cover cleanup after the bookmark has already reached Trash.
  await trash(bookmark, !!bookmark.coverFileId || request !== driveRequest, request);
  if (bookmark.coverFileId) {
    try { await trash({ id: bookmark.coverFileId }, true, request); }
    catch (error) {
      if (error instanceof DriveError && error.status === 404) return;
      throw new BookmarkTrashError(`The bookmark is in Trash, but its cover could not be moved to Trash. Retry deleting this bookmark to finish cleanup. ${(error as Error).message}`);
    }
  }
}

export async function trashCollection(collection: Collection, request = driveRequest): Promise<void> {
  if (collection.system) throw new Error("Unsorted cannot be deleted.");
  await trash(collection, request !== driveRequest, request);
}
export async function uploadImage(file: File, assetsId: string): Promise<string> {
  if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type) || file.size > 10 * 1024 * 1024 || file.size === 0) throw new Error("Choose a PNG, JPG, GIF, or WebP image under 10 MB.");
  return uploadFile(file, assetsId);
}
export async function uploadFile(file: File, assetsId: string): Promise<string> {
  validateFile(file);
  const mimeType = file.type || "application/octet-stream";
  const assets = await metadata(assetsId);
  if (assets.appProperties?.kind !== "assets" || assets.appProperties.app !== "rainbow" || assets.trashed) throw new Error("Invalid assets folder.");
  const boundary = `rainbow_${crypto.randomUUID()}`;
  const body = new Blob([`--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ name: `${crypto.randomUUID()}-${file.name.slice(0, 100)}`, parents: [assetsId], mimeType, appProperties: properties("asset", assets.appProperties.library) })}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`, file, `\r\n--${boundary}--`]);
  return (await (await driveRequest("files?uploadType=multipart&fields=id", { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body }, true)).json()).id;
}
export async function readImage(fileId: string): Promise<Blob> {
  const blob = await (await driveRequest(`files/${validateId(fileId)}?alt=media`)).blob();
  if (!blob.type.startsWith("image/") || blob.size > 50 * 1024 * 1024) throw new Error("This cover is not a supported image up to 50 MB.");
  return blob;
}
