import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { isPublicAddress } from "./url-metadata";
import { metadata, DriveError } from "./drive";
import { serverRequest } from "./create-bookmark-server";
import { validateId } from "./library";
import type { AssetPlan } from "./raindrop-migration-model";

export type TransferEvent = { phase: string; bytes?: number; totalBytes?: number; mimeType?: string; name?: string; done?: boolean; error?: string };

export function validateDownloadUrl(input: string): URL {
  const u = new URL(input), host = u.hostname.replace(/^\[|\]$/g, "");
  if (u.href.length > 8192 || !["http:", "https:"].includes(u.protocol) || u.username || u.password || (u.port && !["80", "443"].includes(u.port)) || (isIP(host) && !isPublicAddress(host))) throw new Error("Unsupported asset URL.");
  return u;
}
async function download(input: string, raindropToken: string, signal: AbortSignal): Promise<http.IncomingMessage> {
  let url = validateDownloadUrl(input);
  for (let hop = 0; hop < 6; hop++) {
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = (url.protocol === "https:" ? https : http).get(url, {
        agent: false, signal,
        // Never send the Raindrop credential to a cover host or redirect target.
        headers: { "User-Agent": "Rainbow/1.0 (Raindrop migration)", ...(url.protocol === "https:" && ["up.raindrop.io", "api.raindrop.io"].includes(url.hostname) ? { Authorization: `Bearer ${raindropToken}` } : {}) },
        lookup(hostname, options, callback) {
          dns.lookup(hostname, { all: true }, (error, addresses) => {
            if (error) return callback(error, "", 4);
            if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) return callback(new Error("Asset URL resolves to a private address."), "", 4);
            if (options.all) callback(null, [addresses[0]]); else callback(null, addresses[0].address, addresses[0].family);
          });
        },
      }, resolve);
      request.on("error", reject);
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
      url = validateDownloadUrl(new URL(response.headers.location, url).href); response.destroy(); continue;
    }
    if (response.statusCode !== 200) { response.destroy(); throw new Error(`File download failed (${response.statusCode}).`); }
    return response;
  }
  throw new Error("Too many asset redirects.");
}

export async function transferAsset(asset: AssetPlan, assetsId: string, accessToken: string, raindropToken: string, emit: (event: TransferEvent) => void, signal: AbortSignal): Promise<void> {
  const request = serverRequest(accessToken), id = validateId(asset.id);
  const assets = await metadata(validateId(assetsId), request);
  if (assets.trashed || assets.appProperties?.app !== "rainbow" || assets.appProperties.kind !== "assets") throw new Error("Invalid Rainbow assets folder.");
  try {
    const existing = await metadata(id, request);
    if (existing.trashed || !existing.parents?.includes(assetsId) || existing.appProperties?.kind !== "asset" || existing.appProperties?.app !== "rainbow" || existing.appProperties.library !== assets.appProperties.library || existing.appProperties.source !== createHash("sha256").update(asset.url).digest("hex")) throw new Error("Invalid migrated asset reference.");
    const saved = await (await request(`files/${id}?fields=size,md5Checksum`)).json();
    if (saved.md5Checksum !== existing.appProperties.checksum || (asset.size !== undefined && Number(saved.size) !== asset.size)) throw new Error("Previously uploaded file could not be verified.");
    emit({ phase: "Uploaded", mimeType: existing.mimeType, name: asset.name, done: true }); return;
  } catch (e) { if (!(e instanceof DriveError) || e.status !== 404) throw e; }
  const directory = await mkdtemp(join(tmpdir(), "rainbow-raindrop-"));
  try {
    const response = await download(asset.url, raindropToken, signal);
    const type = (response.headers["content-type"] || "application/octet-stream").split(";")[0].trim().toLowerCase();
    if (asset.image && !type.startsWith("image/")) { response.destroy(); throw new Error("Cover download did not return an image."); }
    const total = Number(response.headers["content-length"]) || asset.size || undefined;
    let bytes = 0, last = 0;
    const checksum = createHash("md5");
    emit({ phase: "Downloading", bytes, totalBytes: total });
    const meter = new Transform({ transform(chunk, _encoding, cb) {
      bytes += chunk.length;
      checksum.update(chunk);
      if (Date.now() - last > 250) { last = Date.now(); emit({ phase: "Downloading", bytes, totalBytes: total }); }
      cb(null, chunk);
    } });
    const path = join(directory, "original");
    await pipeline(response, meter, createWriteStream(path), { signal });
    const size = (await stat(path)).size;
    const digest = checksum.digest("hex");
    if (asset.size !== undefined && asset.size >= 0 && asset.size !== size) throw new Error("Downloaded file size does not match the Raindrop original.");
    if (total !== undefined && total !== size) throw new Error("File download was incomplete.");
    // Use disk and 8 MiB chunks instead of buffering the entire original in RAM.
    const confirm = async () => {
      const saved = await (await request(`files/${id}?fields=id,size,md5Checksum`)).json();
      if (Number(saved.size) !== size || saved.md5Checksum !== digest) throw new Error("Drive file checksum did not match the downloaded original.");
      emit({ phase: "Uploaded", bytes: size, totalBytes: size, mimeType: type, name: asset.name, done: true });
    };
    const started = await request("files?uploadType=resumable&fields=id", { method: "POST", headers: { "Content-Type": "application/json", "X-Upload-Content-Type": type, "X-Upload-Content-Length": String(size) }, body: JSON.stringify({ id, name: asset.name.slice(0, 1000), parents: [assetsId], mimeType: type, appProperties: { app: "rainbow", kind: "asset", library: assets.appProperties.library, source: createHash("sha256").update(asset.url).digest("hex"), checksum: digest } }) }, true);
    const location = started.headers.get("location");
    if (!location || new URL(location).origin !== "https://www.googleapis.com") throw new Error("Drive did not return a valid upload session.");
    const file = await open(path, "r");
    try {
      let offset = 0;
      emit({ phase: "Uploading", bytes: 0, totalBytes: size });
      while (offset < size || size === 0) {
        signal.throwIfAborted();
        const length = Math.min(8 * 1024 * 1024, size - offset), buffer = Buffer.alloc(length);
        if (length) {
          let read = 0;
          while (read < length) { const result = await file.read(buffer, read, length - read, offset + read); if (!result.bytesRead) throw new Error("Cannot read the downloaded file."); read += result.bytesRead; }
        }
        let accepted = false;
        for (let attempt = 0; attempt < 4; attempt++) {
          let uploaded: Response | undefined;
          try {
            uploaded = await fetch(location, { method: "PUT", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": type, "Content-Length": String(length), "Content-Range": size ? `bytes ${offset}-${offset + length - 1}/${size}` : "bytes */0" }, body: buffer, signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]) });
          } catch { signal.throwIfAborted(); }
          if (uploaded?.ok) { await confirm(); return; }
          if (uploaded?.status === 308) {
            const range = uploaded.headers.get("range")?.match(/^bytes=0-(\d+)$/);
            const next = range ? Number(range[1]) + 1 : 0;
            if (next <= offset || next > offset + length) throw new Error("Drive did not acknowledge the upload chunk.");
            offset = next; accepted = true; break;
          }
          if (uploaded && uploaded.status < 500 && uploaded.status !== 429) throw new DriveError(`Drive file upload failed (${uploaded.status}). Check access and storage quota, then retry.`, uploaded.status);
          // Query the session after an ambiguous PUT before replaying any bytes.
          const status = await fetch(location, { method: "PUT", headers: { Authorization: `Bearer ${accessToken}`, "Content-Length": "0", "Content-Range": `bytes */${size}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) }).catch(() => undefined);
          if (status?.ok) { await confirm(); return; }
          const range = status?.headers.get("range")?.match(/^bytes=0-(\d+)$/);
          if (status?.status === 308 && range && Number(range[1]) + 1 > offset) { offset = Number(range[1]) + 1; accepted = true; break; }
          await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
        }
        if (!accepted) throw new Error("Drive upload could not be confirmed. Retry this file.");
        emit({ phase: "Uploading", bytes: offset, totalBytes: size });
      }
      throw new Error("Drive did not confirm the completed file.");
    } finally { await file.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}
