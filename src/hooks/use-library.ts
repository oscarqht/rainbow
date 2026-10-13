"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import * as drive from "@/lib/drive";
import { loadTokens, clearTokens, disconnect, AuthError } from "@/lib/auth-client";
import { cacheLibrary, getCachedLibrary, clearAccountCache, saveDemoImage, saveDemoFile } from "@/lib/cache";
import { demoLibrary } from "@/lib/demo";
import { validateBookmark, validateCollection, validateFile } from "@/lib/library";
import { descendantIds } from "@/lib/view";
import { OptimisticLibrary } from "@/lib/optimistic-library";
import { enrichBookmark } from "@/lib/enrich-bookmark";
import type { Bookmark, BookmarkData, Collection, CollectionInput, Library, Tokens } from "@/lib/types";
const emptyLibrary = (): Library => ({ rootId: "", assetsId: "", unsortedId: "", collections: [], bookmarks: [], syncedAt: "" });
export function useLibrary() {
  const [account, setAccount] = useState<Tokens | null>(null);
  const [library, setLibrary] = useState<Library>(() => demoLibrary());
  const [ready, setReady] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [collectionIds, setCollectionIds] = useState<Record<string, string>>({});
  const [toast, setToast] = useState("");
  const [cacheWarning, setCacheWarning] = useState("");
  const current = useRef(library);
  const owner = useRef<Tokens | null>(null);
  const syncing = useRef(false);
  const ids = useRef<Record<string, string>>({});
  const resolveId = (id: string) => ids.current[id] ?? id;
  const epoch = useRef(0);
  const publish = useCallback((next: Library) => {
    current.current = next; setLibrary(next);
  }, []);
  const jobs = useRef<OptimisticLibrary | null>(null);
  useEffect(() => {
    jobs.current = new OptimisticLibrary(async (visible, confirmed) => {
      publish(visible);
      setBusy(jobs.current!.busy);
      if (confirmed) {
        try { await cacheLibrary(owner.current?.accountId ?? "demo", confirmed); setCacheWarning(""); }
        catch { setCacheWarning("Local caching is unavailable. Your Drive saves still work."); }
      }
    });
  }, [publish]);
  const sync = useCallback(async (full = false) => {
    if (!owner.current || syncing.current) return;
    syncing.current = true; setError("");
    const start = epoch.current;
    try {
      await jobs.current!.enqueue(current.current, { apply: library => library, save: async library => {
        try { return await drive.loadLibrary(library.rootId.startsWith("demo") ? undefined : full ? { ...library, changeToken: undefined } : library); }
        catch (err) {
          if (!(err instanceof AuthError) || loadTokens()) throw err;
          owner.current = null; setAccount(null); setError(err.message);
          return demoLibrary();
        }
      } });
    } catch (err) {
      if (start !== epoch.current) return;
      setError(err instanceof Error ? err.message : "Unable to sync. Try again.");
    } finally { syncing.current = false; }
  }, []);
  useEffect(() => {
    let alive = true;
    async function initialize() {
      const tokens = loadTokens();
      if (tokens) {
        owner.current = tokens;
        setAccount(tokens);
      }
      try {
        const cached = await getCachedLibrary(tokens?.accountId ?? "demo");
        if (alive && cached) {
          current.current = cached;
          setLibrary(cached);
        }
      } catch {
        /* No usable cache: signed-in users see the first sync; demo users see sample data. */
      }
      if (alive) {
        setReady(true);
        if (tokens) await sync();
      }
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
  const checkOnline = () => {
    if (owner.current && !navigator.onLine) throw new Error("You’re offline. Keep this draft open and save when you’re connected.");
  };
  const parentIdFor = (library: Library, id: string) => {
    const resolved = resolveId(id);
    if (resolved !== library.rootId && !library.collections.some(c => c.id === resolved)) throw new Error("This collection is no longer available. Please choose another collection.");
    return resolved;
  };
  const background = (apply: (library: Library) => Library, save: (library: Library) => Promise<Library>, refreshOnFailure = false) => {
    setToast(""); setError("");
    const accountId = owner.current?.accountId;
    void jobs.current!.enqueue(current.current, { apply, save: async library => {
      if (owner.current?.accountId !== accountId) throw new Error("Your session expired. Please reconnect Google Drive.");
      return save(library);
    } }).catch(error => {
      setToast(error instanceof Error ? error.message : "The change could not be saved. Please try again.");
      if (refreshOnFailure) void sync(true);
    });
  };
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);
  const saveBookmark = async (input: BookmarkData, parentId: string, existing?: Bookmark): Promise<Bookmark> => {
    checkOnline();
    const data = validateBookmark({ ...input, title: !existing && !input.file && !input.title.trim() ? input.url.slice(0, 500) : input.title });
    const pending: Bookmark = { ...existing, ...data, id: existing?.id ?? `pending_${crypto.randomUUID()}`, parentId, version: "0", modifiedTime: new Date().toISOString() };
    background(library => ({ ...library, bookmarks: [...library.bookmarks.filter(b => b.id !== resolveId(pending.id)), { ...pending, id: resolveId(pending.id), parentId: resolveId(parentId) }] }), async library => {
      const parent = parentIdFor(library, parentId);
      const previous = existing ? library.bookmarks.find(b => b.id === resolveId(existing.id)) : undefined;
      if (existing && !previous) throw new Error("This bookmark is no longer available.");
      const enriched = existing ? data : validateBookmark(await enrichBookmark({ ...data, title: input.title }, uploadImage));
      const result = owner.current ? previous ? await drive.editBookmark(data, parent, previous) : await drive.createBookmark(enriched, parent) : { ...pending, ...enriched, id: previous?.id ?? crypto.randomUUID(), parentId: parent, version: String(Number(previous?.version ?? 0) + 1) };
      ids.current[pending.id] = result.id;
      return { ...library, bookmarks: [...library.bookmarks.filter(b => b.id !== result.id), result] };
    });
    return pending;
  };
  const saveCollection = async (input: CollectionInput, existing?: Collection): Promise<Collection> => {
    checkOnline();
    const data = validateCollection(input);
    if (existing && descendantIds(current.current.collections, resolveId(existing.id)).has(resolveId(data.parentId))) throw new Error("A collection cannot be moved inside itself.");
    if (existing?.system && (data.parentId !== current.current.rootId || data.name !== existing.name)) throw new Error("Unsorted must stay at the library root with its original name.");
    const pending: Collection = { ...existing, ...data, id: existing?.id ?? `pending_${crypto.randomUUID()}`, version: "0" };
    background(library => ({ ...library, collections: [...library.collections.filter(c => c.id !== resolveId(pending.id)), { ...pending, id: resolveId(pending.id), parentId: resolveId(data.parentId) }] }), async library => {
      const parentId = parentIdFor(library, data.parentId);
      const previous = existing ? library.collections.find(c => c.id === resolveId(existing.id)) : undefined;
      if (existing && !previous) throw new Error("This collection is no longer available.");
      const result = owner.current ? await drive.saveCollectionInBackground({ ...data, parentId }, previous) : { ...pending, id: previous?.id ?? crypto.randomUUID(), parentId, version: "1" };
      ids.current[pending.id] = result.id;
      setCollectionIds({ ...ids.current });
      return { ...library, collections: [...library.collections.filter(c => c.id !== result.id), result] };
    }, true);
    return pending;
  };
  const trashBookmark = async (bookmark: Bookmark): Promise<void> => {
    checkOnline();
    const apply = (library: Library) => ({ ...library, bookmarks: library.bookmarks.filter(b => b.id !== resolveId(bookmark.id)) });
    background(apply, async library => {
      const previous = library.bookmarks.find(b => b.id === resolveId(bookmark.id));
      if (previous && owner.current) {
        try { await drive.deleteBookmark(previous); }
        catch (error) { if (!(error instanceof drive.BookmarkTrashError)) throw error; setToast(error.message); }
      }
      return apply(library);
    });
  };
  const trashCollection = async (collection: Collection): Promise<void> => {
    if (collection.system) throw new Error("Unsorted is a system collection and cannot be deleted.");
    checkOnline();
    const apply = (library: Library) => {
      const removed = descendantIds(library.collections, resolveId(collection.id));
      return { ...library, collections: library.collections.filter(c => !removed.has(c.id)), bookmarks: library.bookmarks.filter(b => !removed.has(b.parentId)) };
    };
    background(apply, async library => {
      const previous = library.collections.find(c => c.id === resolveId(collection.id));
      if (previous && owner.current) await drive.deleteCollection(previous);
      return apply(library);
    }, true);
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
    if (jobs.current!.busy) throw new Error("Please wait for the current save or sync to finish.");
    if (revoke) await disconnect(); else clearTokens();
    const old = owner.current; epoch.current++; owner.current = null; setAccount(null); setError("");
    current.current = demoLibrary(); setLibrary(current.current);
    if (old) await clearAccountCache(old.accountId).catch(() => undefined);
  };
  return { library, account, ready, busy, error, toast, resolveCollectionId: (id: string) => collectionIds[id] ?? id, dismissToast: () => setToast(""), cacheWarning, sync, saveBookmark, saveCollection, trashBookmark, trashCollection, uploadImage, uploadFile, signOut };
}
