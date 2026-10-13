import { createBookmarkOnServer } from "@/lib/create-bookmark-server";
import { DriveError, type Hints } from "@/lib/drive";
import { validateBookmark, validateId } from "@/lib/library";

export const runtime = "nodejs";
export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin || !request.headers.get("content-type")?.startsWith("application/json")) return Response.json({ error: "Invalid request." }, { status: 403 });
  const token = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/)?.[1];
  if (!token || token.length > 8192) return Response.json({ error: "Connect Google Drive." }, { status: 401 });
  let data, parentId, hints: Hints | undefined;
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2_000_000) { await reader.cancel(); throw new Error(); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    data = validateBookmark(body.data); parentId = validateId(body.parentId);
    if (body.hints !== undefined) {
      const thumbnail = body.hints?.thumbnail;
      if (thumbnail?.mimeType !== "image/jpeg" || typeof thumbnail.image !== "string" || !/^[A-Za-z0-9_-]+={0,2}$/.test(thumbnail.image)) throw new Error();
      hints = { thumbnail: { image: thumbnail.image, mimeType: "image/jpeg" } };
    }
  } catch { return Response.json({ error: "Invalid bookmark." }, { status: 400 }); }
  try { return Response.json(await createBookmarkOnServer(data, parentId, token, hints), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return Response.json({ error: "Couldn’t save this bookmark to Drive. Please try again." }, { status: error instanceof DriveError && error.status === 401 ? 401 : 502 }); }
}
