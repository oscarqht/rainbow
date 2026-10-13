"use client";
import { useEffect, useState } from "react";
import { getDemoImage } from "@/lib/cache";
import type { Bookmark } from "@/lib/types";

export function BookmarkLink({ bookmark, ...props }: { bookmark: Bookmark } & Omit<React.ComponentProps<"a">, "href">) {
  const demoId = bookmark.file?.id.startsWith("demo-file-") ? bookmark.file.id : undefined;
  const [download, setDownload] = useState<{ id: string; url: string }>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!demoId) return;
    let alive = true;
    let url: string | undefined;
    void getDemoImage(demoId).then(blob => {
      if (!alive) return;
      if (!blob) { setError("This file is no longer stored on this device."); return; }
      url = URL.createObjectURL(blob); setDownload({ id: demoId, url });
    }).catch(() => { if (alive) setError("Unable to read this file from this device."); });
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [demoId]);
  return <><a {...props} href={demoId ? (download?.id === demoId ? download.url : undefined) : bookmark.url} download={demoId ? bookmark.file?.name : undefined} target={demoId ? undefined : "_blank"} rel="noopener noreferrer" aria-disabled={demoId && download?.id !== demoId ? true : undefined} />{error && <span role="alert">{error}</span>}</>;
}
