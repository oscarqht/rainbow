"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import * as drive from "@/lib/drive";
import { loadTokens, clearTokens, disconnect, AuthError } from "@/lib/auth-client";
import { cacheLibrary, getCachedLibrary, clearAccountCache, saveDemoImage, saveDemoFile } from "@/lib/cache";
import { demoLibrary } from "@/lib/demo";
import { validateBookmark, validateFile } from "@/lib/library";
import { descendantIds } from "@/lib/view";
import type { Bookmark, BookmarkData, Collection, CollectionInput, Library, Tokens } from "@/lib/types";
const emptyLibrary = (): Library => ({ rootId: "", assetsId: "", unsortedId: "", collections: [], bookmarks: [], syncedAt: "" });
export function useLibrary() {
  // Rendered client-only (see rainbow-client.tsx), so localStorage is readable during the first render:
  // the signed-in state is known immediately, without waiting for any network request.
  const [account, setAccount] = useState<Tokens | null>(loadTokens);
  const [library, setLibrary] = useState<Library>(() => account ? emptyLibrary() : demoLibrary());
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [cacheWarning, setCacheWarning] = useState("");
  const current = useRef(library);
  const owner = useRef<Tokens | null>(account);
  const locked = useRef(false);
  const epoch = useRef(0);
  const publish = useCallback(async (next: Library, cache = true) => {
    current.current = next; setLibrary(next);
    if (!cache) return;
    try { await cacheLibrary(owner.current?.accountId ?? "demo", next); setCacheWarning(""); }
    catch { setCacheWarning("Local caching is unavailable. Your Drive saves still work."); }
  }, []);
  const sync = useCallback(async () => {
    if (!owner.current || locked.current) return;
    locked.current = true; setBusy(true); setError("");
    const start = epoch.current;
    try { const next = await drive.loadLibrary(current.current.rootId.startsWith("demo") ? undefined : current.current); if (start === epoch.current) await publish(next); }
    catch (err) {
      if (start !== epoch.current) return;
      setError(err instanceof Error ? err.message : "Unable to sync. Try again.");
      if (err instanceof AuthError && !loadTokens()) { owner.current = null; setAccount(null); current.current = demoLibrary(); setLibrary(current.current); }
    } finally { if (start === epoch.current) { locked.current = false; setBusy(false); } }
  }, [publish]);
  useEffect(() => {
    let alive = true;
    async function initialize() {
      // Show the cached library first; Drive is checked in the background by sync().
      try { const cached = await getCachedLibrary(owner.current?.accountId ?? "demo"); if (alive && cached) { current.current = cached; setLibrary(cached); } }
      catch { /* No usable cache: signed-in users see the first sync; demo users see sample data. */ }
      if (alive) { setReady(true); await sync(); }
    }
    void initialize();
    return () => { alive = false; };
  }, [sync]);
  useEffect(() => {
    if (!ready || !account) return;
    const onFocus = () => { if (document.visibilityState === "visible") void sync(); };
    const interval = window.setInterval(onFocus, 60_000);
    window.addEventListener("focus", onFocus); window.addEventListener("online", onFocus);
    return () => { window.clearInterval(interval); window.removeEventListener("focus", onFocus); window.removeEventListener("online", onFocus); };
  }, [ready, account, sync]);
  const mutate = async <T,>(fn: () => Promise<T>, reportError = true) => {
    if (locked.current) throw new Error("A sync or save is in progress. Please try again in a moment.");
    if (owner.current && !navigator.onLine) throw new Error("You’re offline. Keep this draft open and save when you’re connected.");
    locked.current = true; setBusy(true); setError("");
    try { return await fn(); } catch (err) { if (reportError) setError(err instanceof Error ? err.message : "The change could not be saved."); throw err; }
    finally { locked.current = false; setBusy(false); }
  };
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);
  const saveBookmark = async (input: BookmarkData, parentId: string, existing?: Bookmark): Promise<Bookmark> => {
    if (!existing && !input.file && (!input.title.trim() || !input.coverFileId)) {
      let metadata: { title?: string; description?: string; thumbnail?: { data: string; mimeType: string } } = {};
      try {
        const response = await fetch("/api/url-metadata", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: input.url, fetchImage: !input.coverFileId }) });
        if (response.ok) metadata = await response.json();
      } catch { /* Metadata is optional; saving the URL still works. */ }
      if (!input.title.trim()) input = { ...input, title: metadata.title || input.url.slice(0, 500), description: input.description.trim() ? input.description : metadata.description || "" };
      if (!input.coverFileId && metadata.thumbnail) {
        try {
          const { data, mimeType } = metadata.thumbnail;
          const image = new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], "bookmark-preview", { type: mimeType });
          // Decode before upload so a broken image never prevents the Drive save.
          const bitmap = await createImageBitmap(image); bitmap.close();
          input = { ...input, coverFileId: await uploadImage(image) };
        } catch { /* Keep saving the bookmark if the preview cannot be stored. */ }
      }
    }
    const data = validateBookmark(input);
    if (existing || !owner.current) return mutate(async () => {
      const result = owner.current ? await drive.saveBookmark(data, parentId, existing) : { ...data, id: existing?.id ?? crypto.randomUUID(), parentId, version: String(Number(existing?.version ?? 0) + 1), modifiedTime: new Date().toISOString(), demoCover: existing?.demoCover };
      await publish({ ...current.current, bookmarks: [...current.current.bookmarks.filter(b => b.id !== result.id), result] }); return result;
    });
    if (locked.current) throw new Error("A sync or save is in progress. Please try again in a moment.");
    if (!navigator.onLine) throw new Error("You’re offline. Keep this draft open and save when you’re connected.");
    const pending: Bookmark = { ...data, id: `pending_${crypto.randomUUID()}`, parentId, version: "0", modifiedTime: new Date().toISOString() };
    setToast("");
    void mutate(async () => {
      // Pending cards stay out of the durable cache until Drive confirms the save.
      await publish({ ...current.current, bookmarks: [...current.current.bookmarks, pending] }, false);
      try {
        const result = await drive.createBookmark(data, parentId);
        await publish({ ...current.current, bookmarks: current.current.bookmarks.map(b => b.id === pending.id ? result : b) });
      } catch {
        await publish({ ...current.current, bookmarks: current.current.bookmarks.filter(b => b.id !== pending.id) });
        setToast(`Couldn’t save “${data.title}” to Drive. Please try again.`);
      }
    }, false).catch(() => undefined);
    return pending;
  };
  const saveCollection = (input: CollectionInput, existing?: Collection) => mutate(async () => {
    if (!input.name.trim()) throw new Error("Give your collection a name.");
    if (existing && descendantIds(current.current.collections, existing.id).has(input.parentId)) throw new Error("A collection cannot be moved inside itself.");
    const result = owner.current ? await drive.saveCollection(input, existing) : { ...existing, ...input, id: existing?.id ?? crypto.randomUUID() };
    await publish({ ...current.current, collections: [...current.current.collections.filter(c => c.id !== result.id), result] }); return result;
  });
  const trashBookmark = (bookmark: Bookmark) => mutate(async () => { if (owner.current) await drive.trashBookmark(bookmark); await publish({ ...current.current, bookmarks: current.current.bookmarks.filter(b => b.id !== bookmark.id) }); });
  const trashCollection = (collection: Collection) => mutate(async () => {
    if (collection.system) throw new Error("Unsorted is a system collection and cannot be deleted.");
    if (owner.current) await drive.trashCollection(collection);
    const ids = descendantIds(current.current.collections, collection.id);
    await publish({ ...current.current, collections: current.current.collections.filter(c => !ids.has(c.id)), bookmarks: current.current.bookmarks.filter(b => !ids.has(b.parentId)) });
  });
  const uploadImage = async (file: File) => {
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type) || file.size > 10 * 1024 * 1024) throw new Error("Choose a PNG, JPG, WebP, or GIF image smaller than 10 MB.");
    return owner.current ? drive.uploadImage(file, current.current.assetsId) : saveDemoImage(file);
  };
  const uploadFile = async (file: File) => {
    validateFile(file);
    return owner.current ? drive.uploadFile(file, current.current.assetsId) : saveDemoFile(file);
  };
  const signOut = async (revoke = false) => {
    if (locked.current) throw new Error("Please wait for the current save or sync to finish.");
    if (revoke) await disconnect(); else clearTokens();
    const old = owner.current; epoch.current++; owner.current = null; setAccount(null); setError("");
    current.current = demoLibrary(); setLibrary(current.current);
    if (old) await clearAccountCache(old.accountId).catch(() => undefined);
  };
  return { library, account, ready, busy, error, toast, dismissToast: () => setToast(""), cacheWarning, sync, saveBookmark, saveCollection, trashBookmark, trashCollection, uploadImage, uploadFile, signOut };
}
