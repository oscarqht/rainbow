"use client";
import { useEffect, useState } from "react";
import { readImage } from "@/lib/drive";
import { getDemoImage } from "@/lib/cache";
export function PrivateImage({ fileId, fallback, alt = "", className }: { fileId?: string; fallback?: string; alt?: string; className?: string }) {
  const [image, setImage] = useState<{ id: string; url: string } | null>(null);
  useEffect(() => {
    if (!fileId) return;
    let alive = true; let objectUrl: string | undefined;
    const load = async () => {
      try { const blob = (fileId.startsWith("demo-image:") || fileId.startsWith("demo-file-")) ? await getDemoImage(fileId) : await readImage(fileId); if (!alive || !blob) return; objectUrl = URL.createObjectURL(blob); setImage({ id: fileId, url: objectUrl }); }
      catch { /* Leave a neutral placeholder if an image was removed from Drive. */ }
    };
    void load(); return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [fileId]);
  const url = image && image.id === fileId ? image.url : fallback;
  // Private authenticated blobs must not go through Next's public image optimizer.
  // eslint-disable-next-line @next/next/no-img-element
  return url ? <img src={url} alt={alt} className={className} loading="lazy" /> : <span aria-hidden="true" className={className ?? "image-placeholder"} />;
}
