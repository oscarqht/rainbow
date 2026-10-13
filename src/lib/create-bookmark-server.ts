import { DriveError, parentRoot, writeJson, type Hints } from "./drive";
import { validateBookmark, validateId } from "./library";
import type { Bookmark, BookmarkData } from "./types";

export async function createBookmarkOnServer(input: BookmarkData, parentId: string, accessToken: string, hints?: Hints): Promise<Bookmark> {
  const data = validateBookmark(input);
  validateId(parentId);
  const request = async (path: string, init: RequestInit = {}, upload = false): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      let response: Response | undefined;
      try {
        response = await fetch(`https://www.googleapis.com/${upload ? "upload/" : ""}drive/v3/${path}`, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), Authorization: `Bearer ${accessToken}` }, cache: "no-store", signal: AbortSignal.timeout(15000) });
      } catch { /* Retry transport failures with the same preallocated file ID. */ }
      const reason = response?.status === 403 ? await response.clone().json().catch(() => null) : null;
      const limited = ["rateLimitExceeded", "userRateLimitExceeded", "RATE_LIMIT_EXCEEDED"].includes(reason?.error?.errors?.[0]?.reason ?? reason?.error?.details?.[0]?.reason);
      if ((!response || response.status === 429 || response.status >= 500 || limited) && attempt < 2) {
        const seconds = Number(response?.headers.get("Retry-After"));
        await new Promise(resolve => setTimeout(resolve, Math.min(10000, seconds > 0 ? seconds * 1000 : 500 * 2 ** attempt)));
        continue;
      }
      if (!response?.ok) throw new DriveError("Couldn’t save this bookmark to Drive. Please try again.", response?.status ?? 503);
      return response;
    }
  };
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
