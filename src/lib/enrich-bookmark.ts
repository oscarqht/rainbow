import type { BookmarkData } from "./types";

export async function enrichBookmark(input: BookmarkData, uploadImage: (file: File) => Promise<string>): Promise<BookmarkData> {
  if (input.file || (input.title.trim() && input.description.trim() && input.coverFileId)) return input;
  let metadata: { title?: string; description?: string; thumbnail?: { data: string; mimeType: string } } = {};
  try {
    const response = await fetch("/api/url-metadata", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: input.url, fetchImage: !input.coverFileId }) });
    if (response.ok) metadata = await response.json();
  } catch { /* Metadata is optional; saving the URL still works. */ }
  const data = { ...input, title: input.title.trim() ? input.title : metadata.title || input.url.slice(0, 500), description: input.description.trim() ? input.description : metadata.description || "" };
  if (!data.coverFileId && metadata.thumbnail) {
    try {
      const { data: imageData, mimeType } = metadata.thumbnail;
      const image = new File([Uint8Array.from(atob(imageData), c => c.charCodeAt(0))], "bookmark-preview", { type: mimeType });
      // Decode before upload so a broken image never prevents the Drive save.
      const bitmap = await createImageBitmap(image); bitmap.close();
      data.coverFileId = await uploadImage(image);
    } catch { /* Keep saving the bookmark if the preview cannot be stored. */ }
  }
  return data;
}
