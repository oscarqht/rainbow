import type { BookmarkData, CollectionInput } from "./types";

function text(value: unknown, name: string, max: number, required = false): string {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) throw new Error(`${name} must be ${required ? "nonempty and " : ""}at most ${max} characters.`);
  return value;
}
export function validateBookmark(value: unknown): BookmarkData {
  if (!value || typeof value !== "object") throw new Error("Invalid bookmark JSON.");
  const b = value as Record<string, unknown>;
  if (b.schemaVersion !== 1) throw new Error("Unsupported bookmark schema. Update Rainbow before editing this file.");
  let file: BookmarkData["file"];
  if (b.file !== undefined) {
    if (!b.file || typeof b.file !== "object") throw new Error("Invalid bookmark file.");
    const f = b.file as Record<string, unknown>;
    file = { id: validateId(f.id), name: text(f.name, "File name", 1000, true), mimeType: text(f.mimeType, "File type", 200, true) };
  }
  const url = file ? `https://drive.google.com/file/d/${file.id}/view` : text(b.url, "URL", 8192, true);
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("Enter a valid HTTP or HTTPS URL."); }
  if (!["https:", "http:"].includes(parsed.protocol)) throw new Error("Only HTTP and HTTPS bookmarks are supported.");
  if (!Array.isArray(b.tags) || b.tags.length > 50) throw new Error("Use at most 50 tags.");
  const tags = [...new Set(b.tags.map(t => text(t, "Tag", 100, true).trim()))];
  return { schemaVersion: 1, ...(file ? { file } : {}), url: parsed.href, title: text(b.title, "Title", 500, true), description: text(b.description, "Description", 5000), note: text(b.note, "Note", 100000), tags, ...(b.coverFileId ? { coverFileId: validateId(b.coverFileId) } : {}) };
}
export function validateId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(value)) throw new Error("Invalid Drive file reference.");
  return value;
}
export function validateCollection(value: CollectionInput): CollectionInput {
  if (!["grid", "list"].includes(value.view) || !Number.isFinite(value.order)) throw new Error("Invalid collection settings.");
  if (value.color && !/^#[0-9a-fA-F]{6}$/.test(value.color)) throw new Error("Use a six-digit hex color.");
  return { view: value.view, order: value.order, ...(value.color ? { color: value.color } : {}), name: text(value.name, "Collection name", 200, true).trim(), parentId: validateId(value.parentId), ...(value.iconFileId ? { iconFileId: validateId(value.iconFileId) } : {}) };
}

export function validateFile(file: File): void {
  if (!file.size || file.size > 50 * 1024 * 1024) throw new Error("Choose a nonempty file up to 50 MB.");
  if (!file.name || file.name.length > 1000 || /[\r\n]/.test(file.type)) throw new Error("Invalid file name or type.");
}
