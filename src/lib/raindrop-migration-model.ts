import type { BookmarkData } from "./types";
import { validateBookmark } from "./library";

export type SourceCollection = Record<string, unknown> & { _id: number; title: string; parent?: { $id: number }; sort?: number; view?: string; color?: string; cover?: string[] };
export type SourceItem = Record<string, unknown> & { _id: number; link: string; title?: string; excerpt?: string; note?: string; tags?: string[]; collection: { $id: number }; cover?: string; media?: { link: string }[]; file?: { name: string; size: number; type: string } };
export type AssetPlan = { url: string; id: string; done?: boolean; name: string; image: boolean; size?: number; mimeType?: string };
export type CollectionPlan = { source: SourceCollection; folder: string; config: string; icon?: AssetPlan; created?: boolean; done?: boolean; error?: string; scanned?: boolean; nextPage: number };
export type ItemPlan = { source: SourceItem; id: string; assets: AssetPlan[]; done?: boolean; error?: string };
export type PagePlan = { id: string; collectionId: number; page: number; ready?: boolean; count: number; done: number; failed: number };
export type Migration = { schemaVersion: 1; id: string; accountId: string; rootId: string; assetsId: string; collections: CollectionPlan[]; pages: PagePlan[]; discovered?: boolean; status: "paused" | "incomplete" | "complete"; startedAt: string };
export type ItemPage = { schemaVersion: 1; collectionId: number; page: number; items: ItemPlan[]; last: boolean };
export type MigrationProgress = { phase: string; current: string; collections: number; collectionTotal: number; bookmarks: number; bookmarkTotal: number; failed: number; discovering: boolean; bytes?: number; totalBytes?: number };

export function publicAssetUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 8192) return false;
  try { const u = new URL(value); return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
}
export function itemAssets(item: SourceItem): Omit<AssetPlan, "id">[] {
  const assets: Omit<AssetPlan, "id">[] = [];
  if (item.file) {
    if (!publicAssetUrl(item.link)) throw new Error("Uploaded file has no valid download URL.");
    assets.push({ url: item.link, name: item.file.name || `raindrop-${item._id}`, image: false, size: item.file.size, mimeType: item.file.type });
  }
  for (const url of [item.cover, ...(item.media ?? []).map(m => m.link)]) {
    if (!url || url === "<screenshot>" || assets.some(a => a.url === url)) continue;
    // Validate during transfer so a bad cover remains retryable without blocking the link.
    assets.push({ url, name: `raindrop-${item._id}-cover`, image: true });
  }
  return assets;
}
export function importedBookmark(item: ItemPlan, accountId: string): BookmarkData {
  const source = item.source;
  const original = source.file ? item.assets.find(a => a.url === source.link && a.done) : undefined;
  if (source.file && !original) throw new Error("Original file has not been uploaded.");
  const cover = item.assets.find(a => a.url === source.cover && a.done) ?? (original?.mimeType?.startsWith("image/") ? original : undefined);
  return validateBookmark({ schemaVersion: 1, url: source.link,
    title: (source.title?.trim() || source.file?.name || source.link || `Raindrop ${source._id}`).slice(0, 500),
    description: (source.excerpt || "").slice(0, 5000), note: (source.note || "").slice(0, 100000),
    tags: [...new Set((source.tags || []).map(t => t.trim().slice(0, 100)).filter(Boolean))].slice(0, 50),
    ...(original ? { file: { id: original.id, name: original.name.slice(0, 1000), mimeType: original.mimeType || "application/octet-stream" } } : {}),
    ...(cover ? { coverFileId: cover.id } : {}),
    raindrop: { accountId, item: source, assets: item.assets.filter(a => a.done).map(a => ({ url: a.url, id: a.id })) },
  });
}
export function migrationProgress(m: Migration, phase: string, current = ""): MigrationProgress {
  return { phase, current, collections: m.collections.filter(c => c.done).length, collectionTotal: m.collections.length,
    bookmarks: m.pages.reduce((n, p) => n + p.done, 0), bookmarkTotal: m.pages.reduce((n, p) => n + p.count, 0),
    failed: m.collections.filter(c => c.error).length + m.pages.reduce((n, p) => n + p.failed, 0), discovering: !m.discovered };
}
export function rateLimitUntil(headers: Headers, now = Date.now()): number {
  const retry = headers.get("retry-after");
  const seconds = retry === null ? NaN : Number(retry);
  const reset = Number(headers.get("x-ratelimit-reset"));
  return Math.max(now, Number.isFinite(seconds) ? now + Math.max(0, seconds) * 1000 : Date.parse(retry || "") || 0,
    Number.isFinite(reset) && reset > 0 ? reset * 1000 + 1000 : 0);
}
