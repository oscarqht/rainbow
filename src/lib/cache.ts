import type { Library } from "./types";
const NAME = "rainbow-cache";
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("data");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Cache is blocked by another tab."));
    // IndexedDB can stall indefinitely in some browser states; the cache is optional, so never wait on it forever.
    setTimeout(() => reject(new Error("Cache timed out.")), 3000);
  });
}
async function operation<T>(key: string, value?: T, remove = false): Promise<T | undefined> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("data", value !== undefined || remove ? "readwrite" : "readonly");
      const store = tx.objectStore("data");
      const request = remove ? store.delete(key) : value !== undefined ? store.put(value, key) : store.get(key);
      let result: T | undefined;
      request.onsuccess = () => { result = request.result as T | undefined; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
export const getCachedLibrary = (account: string) => operation<Library>(`library:${account}`);
export const cacheLibrary = (account: string, library: Library) => operation(`library:${account}`, library);
export async function clearAccountCache(account: string) { await operation(`library:${account}`, undefined, true); }
export async function saveDemoImage(file: File): Promise<string> { const id = `demo-image-${crypto.randomUUID()}`; await operation(id, file); return id; }
export async function getDemoImage(id: string): Promise<Blob | undefined> { return operation<Blob>(id); }

export async function saveDemoFile(file: File): Promise<string> { const id = `demo-file-${crypto.randomUUID()}`; await operation(id, file); return id; }
