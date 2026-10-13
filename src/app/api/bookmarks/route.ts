import { createBookmarkOnServer, editBookmarkOnServer, deleteBookmarkOnServer } from "@/lib/create-bookmark-server";
import { BookmarkTrashError, ConflictError, DriveError, type Hints } from "@/lib/drive";
import { validateBookmark, validateId } from "@/lib/library";

import { readMutationBody } from "@/lib/mutation-request";
import type { Bookmark } from "@/lib/types";

export const runtime = "nodejs";

export const POST = (request: Request) => handle(request, "create");
export const PATCH = (request: Request) => handle(request, "edit");
export const DELETE = (request: Request) => handle(request, "delete");
async function handle(request: Request, action: "create" | "edit" | "delete") {
  if (request.headers.get("origin") !== new URL(request.url).origin || !request.headers.get("content-type")?.startsWith("application/json")) return Response.json({ error: "Invalid request." }, { status: 403 });
  const token = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/)?.[1];
  if (!token || token.length > 8192) return Response.json({ error: "Connect Google Drive." }, { status: 401 });
  let data, parentId, existing: Bookmark | undefined, hints: Hints | undefined;
  try {
    const body = await readMutationBody(request) as { data?: unknown; parentId?: unknown; existing?: Bookmark; hints?: Hints };
    if (action !== "create") {
      const b = body.existing;
      if (!b || typeof b.modifiedTime !== "string" || !b.modifiedTime || b.modifiedTime.length > 100 || typeof b.version !== "string") throw new Error();
      existing = { ...validateBookmark(b), id: validateId(b.id), parentId: validateId(b.parentId), modifiedTime: b.modifiedTime, version: b.version };
    }
    if (action !== "delete") { data = validateBookmark(body.data); parentId = validateId(body.parentId); }
    if (body.hints !== undefined) {
      const thumbnail = body.hints?.thumbnail;
      if (thumbnail?.mimeType !== "image/jpeg" || typeof thumbnail.image !== "string" || !/^[A-Za-z0-9_-]+={0,2}$/.test(thumbnail.image)) throw new Error();
      hints = { thumbnail: { image: thumbnail.image, mimeType: "image/jpeg" } };
    }
  } catch { return Response.json({ error: "Invalid bookmark." }, { status: 400 }); }
  try {
    const result = action === "delete" ? await deleteBookmarkOnServer(existing!, token) : action === "edit" ? await editBookmarkOnServer(data!, parentId!, existing!, token, hints) : await createBookmarkOnServer(data!, parentId!, token, hints);
    return Response.json(result ?? null, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof ConflictError ? "This bookmark changed in Drive. Sync your library before trying again." : error instanceof BookmarkTrashError ? "Bookmark deleted, but its cover couldn’t be cleaned up. Retry sync to refresh your library." : `Couldn’t ${action === "delete" ? "delete" : "save"} this bookmark in Drive. Please try again.`;
    return Response.json({ error: message, ...(error instanceof BookmarkTrashError ? { bookmarkDeleted: true } : {}) }, { status: error instanceof ConflictError ? 409 : error instanceof DriveError && error.status === 401 ? 401 : 502 });
  }
}
