import { deleteCollectionOnServer, saveCollectionOnServer } from "@/lib/collection-server";
import { ConflictError, DriveError } from "@/lib/drive";
import { validateCollection, validateId } from "@/lib/library";
import { readMutationBody } from "@/lib/mutation-request";
import type { Collection } from "@/lib/types";

export const runtime = "nodejs";
export const POST = (request: Request) => handle(request, "create");
export const PATCH = (request: Request) => handle(request, "edit");
export const DELETE = (request: Request) => handle(request, "delete");
async function handle(request: Request, action: "create" | "edit" | "delete") {
  if (request.headers.get("origin") !== new URL(request.url).origin || !request.headers.get("content-type")?.startsWith("application/json")) return Response.json({ error: "Invalid request." }, { status: 403 });
  const token = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/)?.[1];
  if (!token || token.length > 8192) return Response.json({ error: "Connect Google Drive." }, { status: 401 });
  let data, existing: Collection | undefined;
  try {
    const body = await readMutationBody(request) as { data?: unknown; existing?: Collection };
    if (action !== "create") {
      const c = body.existing;
      if (!c || typeof c.modifiedTime !== "string" || !c.modifiedTime || c.modifiedTime.length > 100) throw new Error();
      if (c.configId && (typeof c.configModifiedTime !== "string" || !c.configModifiedTime || c.configModifiedTime.length > 100)) throw new Error();
      existing = { ...validateCollection(c), id: validateId(c.id), modifiedTime: c.modifiedTime, ...(c.configId ? { configId: validateId(c.configId), configModifiedTime: c.configModifiedTime } : {}) };
    }
    if (action !== "delete") data = validateCollection(body.data as Collection);
  } catch { return Response.json({ error: "Invalid collection." }, { status: 400 }); }
  try {
    const result = action === "delete" ? await deleteCollectionOnServer(existing!, token) : await saveCollectionOnServer(data!, token, existing);
    return Response.json(result ?? null, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof ConflictError ? "This collection changed in Drive. Sync your library before trying again." : `Couldn’t ${action === "delete" ? "delete" : "save"} this collection in Drive. Please try again.` }, { status: error instanceof ConflictError ? 409 : error instanceof DriveError && error.status === 401 ? 401 : 502 });
  }
}
