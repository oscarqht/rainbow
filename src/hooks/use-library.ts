"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import * as drive from "@/lib/drive";
import { loadTokens, clearTokens, disconnect, AuthError } from "@/lib/auth-client";
import { cacheLibrary, getCachedLibrary, clearAccountCache, saveDemoImage, saveDemoFile } from "@/lib/cache";
import { demoLibrary } from "@/lib/demo";
import { validateBookmark, validateCollection, validateFile } from "@/lib/library";
import { descendantIds } from "@/lib/view";
import { enrichBookmark } from "@/lib/enrich-bookmark";
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
  const [collectionIds, setCollectionIds] = useState<Record<string, string>>({});
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
    const data = validateBookmark({ ...input, title: !existing && !input.file && !input.title.trim() ? input.url.slice(0, 500) : input.title });
    if (existing && !owner.current) return mutate(async () => {
      const result = { ...data, id: existing.id, parentId, version: String(Number(existing.version ?? 0) + 1), modifiedTime: new Date().toISOString(), demoCover: existing.demoCover };
      await publish({ ...current.current, bookmarks: [...current.current.bookmarks.filter(b => b.id !== result.id), result] }); return result;
    });
    if (locked.current) throw new Error("A sync or save is in progress. Please try again in a moment.");
    if (owner.current && !navigator.onLine) throw new Error("You’re offline. Keep this draft open and save when you’re connected.");
    const previous = current.current;
    const pending: Bookmark = { ...data, id: existing?.id ?? `pending_${crypto.randomUUID()}`, parentId, version: "0", modifiedTime: new Date().toISOString() };
    setToast("");
    void mutate(async () => {
      // Pending cards stay out of the durable cache until Drive confirms the save.
      await publish({ ...current.current, bookmarks: [...current.current.bookmarks.filter(b => b.id !== pending.id), pending] }, false);
      try {
        const enriched = existing ? data : validateBookmark(await enrichBookmark({ ...data, title: input.title }, uploadImage));
        if (!existing) await publish({ ...current.current, bookmarks: current.current.bookmarks.map(b => b.id === pending.id ? { ...pending, ...enriched } : b) }, false);
        const result = existing ? await drive.editBookmark(data, parentId, existing) : owner.current ? await drive.createBookmark(enriched, parentId) : { ...enriched, id: crypto.randomUUID(), parentId, version: "1", modifiedTime: new Date().toISOString() };
        await publish({ ...current.current, bookmarks: current.current.bookmarks.map(b => b.id === pending.id ? result : b) });
      } catch (error) {
        await publish(previous);
        setToast(error instanceof Error ? error.message : `Couldn’t save “${data.title}”${owner.current ? " to Drive" : ""}. Please try again.`);
      }
    }, false).catch(() => undefined);
    return pending;
  };
  const saveCollection = async (input: CollectionInput, existing?: Collection): Promise<Collection> => {
    const data = validateCollection(input);
    if (existing && descendantIds(current.current.collections, existing.id).has(data.parentId)) throw new Error("A collection cannot be moved inside itself.");
    if (existing?.system && (data.parentId !== current.current.rootId || data.name !== existing.name)) throw new Error("Unsorted must stay at the library root with its original name.");
    if (!owner.current) return mutate(async () => {
      const result = { ...existing, ...data, id: existing?.id ?? crypto.randomUUID() };
      await publish({ ...current.current, collections: [...current.current.collections.filter(c => c.id !== result.id), result] }); return result;
    });
    if (locked.current) throw new Error("A sync or save is in progress. Please try again in a moment.");
    if (!navigator.onLine) throw new Error("You’re offline. Keep this draft open and save when you’re connected.");
    const previous = current.current;
    const pending: Collection = { ...existing, ...data, id: existing?.id ?? `pending_${crypto.randomUUID()}`, version: "0" };
    let failed = false;
    setToast("");
    void mutate(async () => {
      await publish({ ...current.current, collections: [...current.current.collections.filter(c => c.id !== pending.id), pending] }, false);
      try {
        const result = await drive.saveCollectionInBackground(data, existing);
        if (pending.id !== result.id) setCollectionIds(ids => ({ ...ids, [pending.id]: result.id }));
        await publish({ ...current.current, collections: current.current.collections.map(c => c.id === pending.id ? result : c) });
      } catch (error) {
        failed = true;
        // Folder and settings writes are separate; force a full refresh after rollback.
        await publish({ ...previous, changeToken: undefined });
        setToast(error instanceof Error ? error.message : "Couldn’t save this collection. Please try again.");
      }
    }, false).catch(() => undefined).finally(() => { if (failed) void sync(); });
    return pending;
  };
  const trashBookmark = async (bookmark: Bookmark): Promise<void> => {
    if (!owner.current) return mutate(async () => { await publish({ ...current.current, bookmarks: current.current.bookmarks.filter(b => b.id !== bookmark.id) }); });
    if (locked.current) throw new Error("A sync or save is in progress. Please try again in a moment.");
    if (!navigator.onLine) throw new Error("You’re offline. Delete when you’re connected.");
    const previous = current.current;
    setToast("");
    void mutate(async () => {
      await publish({ ...current.current, bookmarks: current.current.bookmarks.filter(b => b.id !== bookmark.id) }, false);
      try {
        await drive.deleteBookmark(bookmark);
        await publish(current.current);
      } catch (error) {
        // Cover cleanup can fail after the bookmark has already reached Trash.
        if (error instanceof drive.BookmarkTrashError) {
          await publish(current.current);
          setToast(error.message);
        } else {
          await publish(previous);
          setToast(error instanceof Error ? error.message : `Couldn’t delete “${bookmark.title}” from Drive. Please try again.`);
        }
      }
    }, false).catch(() => undefined);
  };
  const trashCollection = async (collection: Collection): Promise<void> => {
    if (collection.system) throw new Error("Unsorted is a system collection and cannot be deleted.");
    if (locked.current) throw new Error("A sync or save is in progress. Please try again in a moment.");
    if (owner.current && !navigator.onLine) throw new Error("You’re offline. Delete when you’re connected.");
    const previous = current.current;
    const ids = descendantIds(previous.collections, collection.id);
    const next = { ...previous, collections: previous.collections.filter(c => !ids.has(c.id)), bookmarks: previous.bookmarks.filter(b => !ids.has(b.parentId)) };
    if (!owner.current) return mutate(() => publish(next));
    let failed = false;
    setToast("");
    void mutate(async () => {
      await publish(next, false);
      try { await drive.deleteCollection(collection); await publish(current.current); }
      catch (error) {
        failed = true;
        await publish({ ...previous, changeToken: undefined });
        setToast(error instanceof Error ? error.message : "Couldn’t delete this collection. Please try again.");
      }
    }, false).catch(() => undefined).finally(() => { if (failed) void sync(); });
  };
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
  return { library, account, ready, busy, error, toast, resolveCollectionId: (id: string) => collectionIds[id] ?? id, dismissToast: () => setToast(""), cacheWarning, sync, saveBookmark, saveCollection, trashBookmark, trashCollection, uploadImage, uploadFile, signOut };
}
