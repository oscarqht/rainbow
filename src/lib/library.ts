import type { BookmarkData, CollectionInput } from "./types";

function text(value: unknown, name: string, max: number, required = false): string {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) throw new Error(`${name} must be ${required ? "nonempty and " : ""}at most ${max} characters.`);
  return value;
}
export function validateBookmark(value: unknown): BookmarkData {
  if (!value || typeof value !== "object") throw new Error("Invalid bookmark JSON.");
  const b = value as Record<string, unknown>;
  if (b.schemaVersion !== 1) throw new Error("Unsupported bookmark schema. Update Rainbow before editing this file.");
  const url = text(b.url, "URL", 8192, true);
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("Enter a valid HTTP or HTTPS URL."); }
  if (!["https:", "http:"].includes(parsed.protocol)) throw new Error("Only HTTP and HTTPS bookmarks are supported.");
  if (!Array.isArray(b.tags) || b.tags.length > 50) throw new Error("Use at most 50 tags.");
  const tags = [...new Set(b.tags.map(t => text(t, "Tag", 100, true).trim()))];
  return { schemaVersion: 1, url: parsed.href, title: text(b.title, "Title", 500, true), description: text(b.description, "Description", 5000), note: text(b.note, "Note", 100000), tags, ...(b.coverFileId ? { coverFileId: validateId(b.coverFileId) } : {}) };
}
export function validateId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(value)) throw new Error("Invalid Drive file reference.");
  return value;
}
export function validateCollection(value: CollectionInput): CollectionInput {
  if (!["grid", "list"].includes(value.view) || !Number.isFinite(value.order)) throw new Error("Invalid collection settings.");
  if (value.color && !/^#[0-9a-fA-F]{6}$/.test(value.color)) throw new Error("Use a six-digit hex color.");
  return { ...value, name: text(value.name, "Collection name", 200, true).trim(), parentId: validateId(value.parentId), ...(value.iconFileId ? { iconFileId: validateId(value.iconFileId) } : {}) };
}
