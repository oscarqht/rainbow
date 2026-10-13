import { ConflictError, DriveError, metadata, parentRoot, trashBookmark, writeJson, type Hints } from "./drive";
import { validateBookmark, validateId } from "./library";
import type { Bookmark, BookmarkData } from "./types";

export function serverRequest(accessToken: string) {
  return async (path: string, init: RequestInit = {}, upload = false): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      let response: Response | undefined;
      try {
        response = await fetch(`https://www.googleapis.com/${upload ? "upload/" : ""}drive/v3/${path}`, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), Authorization: `Bearer ${accessToken}` }, cache: "no-store", signal: AbortSignal.timeout(15000) });
      } catch { /* Retry reads and writes with the same file ID and If-Match condition. */ }
      const reason = response?.status === 403 ? await response.clone().json().catch(() => null) : null;
      const limited = ["rateLimitExceeded", "userRateLimitExceeded", "RATE_LIMIT_EXCEEDED"].includes(reason?.error?.errors?.[0]?.reason ?? reason?.error?.details?.[0]?.reason);
      if ((!response || response.status === 429 || response.status >= 500 || limited) && attempt < 2) {
        const seconds = Number(response?.headers.get("Retry-After"));
        await new Promise(resolve => setTimeout(resolve, Math.min(10000, seconds > 0 ? seconds * 1000 : 500 * 2 ** attempt)));
        continue;
      }
      if (response?.status === 412) throw new ConflictError();
      if (!response?.ok) throw new DriveError("Couldn’t save this bookmark to Drive. Please try again.", response?.status ?? 503);
      return response;
    }
  };
}

export async function createBookmarkOnServer(input: BookmarkData, parentId: string, accessToken: string, hints?: Hints): Promise<Bookmark> {
  const data = validateBookmark(input);
  validateId(parentId);
  const request = serverRequest(accessToken);
  const library = await parentRoot(parentId, request);
  const { ids } = await (await request("files/generateIds?count=1&space=drive&type=files")).json();
  const id = validateId(ids?.[0]);
  let file;
  try { file = await writeJson(`${data.title}.json`, data, "bookmark", parentId, library, undefined, hints, request, id); }
  catch (error) {
    // A lost response may mean the first create succeeded. Drive returns 409 on
    // the retry with the same ID; read the committed file instead of duplicating it.
    if (!(error instanceof DriveError) || error.status !== 409) throw error;
    file = await (await request(`files/${id}?fields=id,modifiedTime,version`)).json();
  }
  return { ...data, id: file.id, parentId, modifiedTime: file.modifiedTime, version: file.version };
}

export async function editBookmarkOnServer(input: BookmarkData, parentId: string, existing: Bookmark, accessToken: string, hints?: Hints): Promise<Bookmark> {
  const data = validateBookmark(input), request = serverRequest(accessToken);
  const library = await parentRoot(validateId(parentId), request);
  const latest = await metadata(validateId(existing.id), request);
  if (latest.appProperties?.app !== "rainbow" || latest.appProperties?.library !== library || latest.appProperties?.kind !== "bookmark") throw new Error("Invalid bookmark reference.");
  try {
    if (latest.trashed || latest.modifiedTime !== existing.modifiedTime) throw new ConflictError();
    const file = await writeJson(`${data.title}.json`, data, "bookmark", parentId, library, latest, hints, request);
    return { ...data, id: file.id, parentId, modifiedTime: file.modifiedTime, version: file.version, etag: file.etag };
  } catch (error) {
    // Confirm an ambiguous write before rolling back the optimistic edit.
    try {
      const file = await metadata(existing.id, request);
      if (!file.trashed && file.parents?.includes(parentId) && file.name === `${data.title}.json`) {
        const saved = validateBookmark(await (await request(`files/${existing.id}?alt=media`)).json());
        if (JSON.stringify(saved) === JSON.stringify(data)) return { ...data, id: file.id, parentId, modifiedTime: file.modifiedTime, version: file.version, etag: file.etag };
      }
    } catch { /* Preserve the original save error if confirmation also fails. */ }
    throw error;
  }
}

export async function deleteBookmarkOnServer(existing: Bookmark, accessToken: string): Promise<void> {
  const request = serverRequest(accessToken), id = validateId(existing.id);
  const file = await metadata(id, request);
  if (file.appProperties?.app !== "rainbow" || file.appProperties?.kind !== "bookmark") throw new Error("Invalid bookmark reference.");
  // Read the saved cover reference, rather than trusting one supplied by the browser.
  const data = validateBookmark(await (await request(`files/${id}?alt=media`)).json());
  await trashBookmark({ ...existing, ...data, id }, request);
}
