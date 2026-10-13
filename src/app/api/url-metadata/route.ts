import { fetchUrlMetadata } from "@/lib/url-metadata";

export const runtime = "nodejs";
export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin || !request.headers.get("content-type")?.startsWith("application/json")) return Response.json({ error: "Invalid request." }, { status: 403 });
  let url: string;
  try {
    // The request is only a URL; bound the body before parsing it.
    const reader = request.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 20_000) { await reader.cancel(); throw new Error(); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    url = JSON.parse(Buffer.concat(chunks).toString("utf8")).url;
    if (typeof url !== "string" || url.length > 8192 || !["http:", "https:"].includes(new URL(url).protocol)) throw new Error();
  } catch { return Response.json({ error: "Invalid URL." }, { status: 400 }); }
  try { return Response.json(await fetchUrlMetadata(url), { headers: { "Cache-Control": "no-store" } }); }
  catch { return Response.json({ title: "", description: "" }, { headers: { "Cache-Control": "no-store" } }); }
}
