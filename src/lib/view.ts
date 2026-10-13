import type { Bookmark, Collection } from "./types";
export function filterBookmarks(bookmarks: Bookmark[], collection: string, tag: string | null, query: string) {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return bookmarks.filter(b => (collection === "all" || b.parentId === collection) && (!tag || b.tags.includes(tag)) && terms.every(term => [b.title, b.url, b.description, b.note, ...b.tags].join(" ").toLocaleLowerCase().includes(term)));
}
export function descendantIds(collections: Collection[], id: string): Set<string> {
  const result = new Set([id]);
  let changed = true;
  while (changed) { changed = false; for (const c of collections) if (result.has(c.parentId) && !result.has(c.id)) { result.add(c.id); changed = true; } }
  return result;
}
export function domain(url: string) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "Bookmark"; } }
