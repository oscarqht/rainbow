import { getAccessToken, loadTokens } from "./auth-client";
import { driveRequest, DriveError, metadata, writeJson } from "./drive";
import { validateId } from "./library";
import { importedBookmark, itemAssets, migrationProgress, publicAssetUrl, rateLimitUntil } from "./raindrop-migration-model";
import type { AssetPlan, ItemPage, ItemPlan, Migration, MigrationProgress, PagePlan, SourceCollection, SourceItem } from "./raindrop-migration-model";
import type { TransferEvent } from "./raindrop-transfer";
import type { Library } from "./types";

type Options = { ownerId: string; library: Library; token: string; paused: () => boolean; progress: (p: MigrationProgress) => void };
class Paused extends Error {}
export class MigrationAuthError extends Error {}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class RaindropMigration {
  private nextRequest = 0;
  private m?: Migration;
  private seen = new Set<number>();
  private checkpoints = new Map<string, Awaited<ReturnType<typeof metadata>>>();
  constructor(private o: Options) {}
  private check(pauseAllowed = true) {
    if (loadTokens()?.accountId !== this.o.ownerId) throw new MigrationAuthError("The Google account changed. Reopen migration in the original account.");
    if (pauseAllowed && this.o.paused()) throw new Paused("Migration paused.");
  }
  private report(phase: string, current = "", extra: Partial<MigrationProgress> = {}) {
    this.o.progress({ ...(this.m ? migrationProgress(this.m, phase, current) : { phase, current, collections: 0, collectionTotal: 0, bookmarks: 0, bookmarkTotal: 0, failed: 0, discovering: true }), ...extra });
  }
  private async wait(until: number) {
    while (Date.now() < until) { this.check(); await pause(Math.min(500, until - Date.now())); }
  }
  private async api(body: Record<string, unknown>, transfer?: (event: TransferEvent) => void): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      this.check();
      if (body.action === "source" || body.action === "asset") {
        if (this.nextRequest > Date.now()) { const current = this.m ? "Pacing Raindrop requests" : "Validating token"; this.report("Waiting", current); await this.wait(this.nextRequest); }
        this.nextRequest = Date.now() + 750;
      }
      const token = await getAccessToken();
      this.check();
      let response: Response;
      try { response = await fetch("/api/migrate/raindrop", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ ...body, ...(body.action === "source" || body.action === "asset" ? { token: this.o.token } : {}) }) }); }
      catch { if (attempt < 2) { await this.wait(Date.now() + 1000 * 2 ** attempt); continue; } throw new Error("Connection interrupted. Resume to retry this operation."); }
      if (response.status === 401 && attempt < 2) { await getAccessToken(true); continue; }
      if (response.status === 429) {
        this.nextRequest = Math.max(Date.now() + 1000, rateLimitUntil(response.headers));
        this.report("Rate limited", "Waiting until Raindrop allows more requests");
        if (attempt < 5) { await this.wait(this.nextRequest); continue; }
        throw new Error("Raindrop is still rate limiting requests. Pause and resume later.");
      }
      if (response.headers.get("x-ratelimit-remaining") === "0") this.nextRequest = Math.max(this.nextRequest, rateLimitUntil(response.headers));
      if (transfer && response.ok && response.body) {
        const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = "", finished = false, failure = "", googleAuth = false;
        try {
          while (true) {
            const { done, value } = await reader.read();
            pending += decoder.decode(value, { stream: !done });
            let boundary: number;
            while ((boundary = pending.indexOf("\n")) !== -1) {
              const line = pending.slice(0, boundary); pending = pending.slice(boundary + 1);
              if (!line) continue;
              const event = JSON.parse(line) as TransferEvent & { googleAuth?: boolean };
              if (event.error) { failure = event.error; googleAuth = !!event.googleAuth; }
              transfer(event); finished ||= !!event.done;
            }
            if (done) break;
          }
        } finally { reader.releaseLock(); }
        if (failure) {
          if (googleAuth && attempt < 2) { await getAccessToken(true); continue; }
          throw new Error(failure);
        }
        if (!finished) throw new Error("File transfer was interrupted. Resume to retry the original file.");
        return {};
      }
      const data = await response.json() as Record<string, unknown>;
      if (data.raindropAuth) throw new MigrationAuthError(String(data.error));
      if (!response.ok) {
        if (response.status >= 500 && attempt < 2) { await this.wait(Date.now() + 1000 * 2 ** attempt); continue; }
        throw new Error(String(data.error || "Migration request failed."));
      }
      return data;
    }
  }
  private async ids(count: number): Promise<string[]> {
    this.check(); const ids: string[] = [];
    while (ids.length < count) {
      const data = await (await driveRequest(`files/generateIds?count=${Math.min(1000, count - ids.length)}&space=drive&type=files`)).json();
      if (!Array.isArray(data.ids) || !data.ids.length) throw new Error("Drive could not allocate migration IDs.");
      ids.push(...data.ids.map(validateId));
    }
    return ids;
  }
  private async read<T>(id: string): Promise<T> {
    this.check(false);
    const meta = await metadata(id);
    if (meta.trashed || meta.appProperties?.app !== "rainbow" || meta.appProperties.library !== this.o.library.rootId || !["migration", "migration-page"].includes(meta.appProperties.kind)) throw new Error("Invalid migration checkpoint.");
    this.checkpoints.set(id, meta);
    return (await driveRequest(`files/${validateId(id)}?alt=media`)).json();
  }
  private async save(id: string, value: Migration | ItemPage, kind: "migration" | "migration-page") {
    this.check(false);
    const name = kind === "migration" ? `_raindrop-migration-${this.m!.accountId}.json` : `_raindrop-page-${id}.json`;
    const existing = this.checkpoints.get(id);
    try { const file = await writeJson(name, value, kind, this.o.library.rootId, this.o.library.rootId, existing, undefined, driveRequest, existing ? undefined : id); this.checkpoints.set(id, file); }
    catch (error) {
      // Confirm a lost response, but never silently overwrite a conflicting checkpoint.
      try { const saved = await this.read<Migration | ItemPage>(id); if (JSON.stringify(saved) === JSON.stringify(value)) return; } catch { /* Leave the failure visible. */ }
      throw error;
    }
  }
  private async saveIndex() { await this.save(this.m!.id, this.m!, "migration"); }
  private async page(plan: PagePlan): Promise<ItemPage> {
    const page = await this.read<ItemPage>(plan.id);
    if (page.schemaVersion !== 1 || page.page !== plan.page || page.collectionId !== plan.collectionId || !Array.isArray(page.items)) throw new Error("Invalid migration page checkpoint.");
    plan.count = page.items.length; plan.done = page.items.filter(i => i.done).length; plan.failed = page.items.filter(i => i.error).length;
    page.items.forEach(i => this.seen.add(i.source._id));
    return page;
  }
  private async savePage(plan: PagePlan, page: ItemPage) {
    await this.save(plan.id, page, "migration-page");
    plan.count = page.items.length; plan.done = page.items.filter(i => i.done).length; plan.failed = page.items.filter(i => i.error).length;
    this.report("Migrating", "Progress saved in Drive");
  }
  private async load(accountId: string): Promise<Migration | undefined> {
    const q = `trashed=false and '${validateId(this.o.library.rootId)}' in parents and appProperties has { key='app' and value='rainbow' } and appProperties has { key='kind' and value='migration' } and name='_raindrop-migration-${accountId}.json'`;
    const found = await (await driveRequest(`files?${new URLSearchParams({ q, fields: "files(id)", pageSize: "100" })}`)).json();
    if (found.files.length > 1) throw new Error("Multiple migration checkpoints found. Keep one before resuming.");
    if (!found.files.length) return;
    const m = await this.read<Migration>(found.files[0].id);
    if (m.schemaVersion !== 1 || m.accountId !== accountId || m.rootId !== this.o.library.rootId || m.assetsId !== this.o.library.assetsId || !Array.isArray(m.collections) || !Array.isArray(m.pages)) throw new Error("Migration checkpoint belongs to another library or is unsupported.");
    return m;
  }
  private async initialize(): Promise<void> {
    this.report("Connecting", "Validating Raindrop token");
    const user = (await this.api({ action: "source", resource: "user" })).user as { _id?: number };
    if (!Number.isSafeInteger(user?._id) || Number(user._id) <= 0) throw new Error("Raindrop did not identify the account.");
    const accountId = String(user._id);
    this.m = await this.load(accountId);
    if (this.m) {
      this.report("Loading", "Restoring saved progress");
      for (const p of this.m.pages) if (p.ready) { this.check(); await this.page(p); this.report("Loading", "Restoring saved progress"); }
      return;
    }
    this.report("Discovering", "Reading collection hierarchy");
    const roots = await this.api({ action: "source", resource: "collections" });
    const children = await this.api({ action: "source", resource: "children" });
    if (!Array.isArray(roots.items) || !Array.isArray(children.items)) throw new Error("Raindrop returned an invalid collection list.");
    const sources = [...new Map([...roots.items, ...children.items].map(c => [(c as SourceCollection)._id, c as SourceCollection])).values()].filter(c => c._id > 0);
    sources.unshift({ _id: -1, title: "Unsorted" });
    for (const c of sources) if (!Number.isSafeInteger(c._id) || typeof c.title !== "string") throw new Error("Invalid source collection.");
    const ids = await this.ids(1 + sources.length * 3);
    this.m = { schemaVersion: 1, id: ids.shift()!, accountId, rootId: this.o.library.rootId, assetsId: this.o.library.assetsId, startedAt: new Date().toISOString(), status: "paused", pages: [], collections: sources.map(source => {
      const folder = ids.shift()!, config = ids.shift()!, iconId = ids.shift()!;
      const url = source.cover?.[0];
      return { source, folder, config, nextPage: 0, ...(url ? { icon: { url, id: iconId, name: `raindrop-collection-${source._id}-icon`, image: true } } : {}) };
    }) };
    await this.saveIndex();
  }
  private async discover() {
    for (const c of this.m!.collections) {
      while (!c.scanned) {
        this.check(); this.report("Discovering", `${c.source.title} · page ${c.nextPage + 1}`);
        let plan = this.m!.pages.find(p => p.collectionId === c.source._id && p.page === c.nextPage);
        if (!plan) { plan = { id: (await this.ids(1))[0], collectionId: c.source._id, page: c.nextPage, count: 0, done: 0, failed: 0 }; this.m!.pages.push(plan); await this.saveIndex(); }
        let page: ItemPage | undefined;
        try { page = await this.page(plan); }
        catch (e) { if (!(e instanceof DriveError) || e.status !== 404) throw e; }
        if (!page) {
          const data = await this.api({ action: "source", resource: "items", collectionId: c.source._id, page: c.nextPage });
          if (!Array.isArray(data.items)) throw new Error("Invalid source bookmark page.");
          const raw = data.items as SourceItem[];
          for (const item of raw) if (!Number.isSafeInteger(item._id) || item._id <= 0 || item.collection?.$id !== c.source._id) throw new Error("Raindrop returned an invalid bookmark identity or collection.");
          const prepared: { source: SourceItem; assets: Omit<AssetPlan, "id">[]; error?: string }[] = [];
          for (const source of raw) {
            if (this.seen.has(source._id)) continue;
            let assets: Omit<AssetPlan, "id">[] = [], error: string | undefined;
            try { assets = itemAssets(source); } catch (e) { error = (e as Error).message; }
            prepared.push({ source, assets, error }); this.seen.add(source._id);
          }
          const ids = await this.ids(prepared.reduce((n, i) => n + 1 + i.assets.length, 0));
          const items: ItemPlan[] = prepared.map(i => ({ source: i.source, id: ids.shift()!, assets: i.assets.map(a => ({ ...a, id: ids.shift()! })), ...(i.error ? { error: i.error } : {}) }));
          page = { schemaVersion: 1, collectionId: c.source._id, page: c.nextPage, items, last: raw.length < 50 };
          await this.savePage(plan, page);
        }
        plan.ready = true; c.nextPage++; c.scanned = page.last;
        await this.saveIndex();
      }
    }
    this.m!.discovered = true; await this.saveIndex();
  }
  private async asset(a: AssetPlan) {
    if (a.done) return;
    this.check();
    if (!publicAssetUrl(a.url)) throw new Error("Invalid source asset URL.");
    let bytes: number | undefined, totalBytes: number | undefined;
    await this.api({ action: "asset", asset: a, assetsId: this.m!.assetsId }, event => {
      if (event.done) { a.done = true; a.mimeType = event.mimeType; }
      bytes = event.bytes ?? bytes; totalBytes = event.totalBytes ?? totalBytes;
      if (!event.error) this.report(this.o.paused() ? "Pausing" : event.phase, a.name, { bytes, totalBytes });
    });
  }
  private async collections() {
    const pending = this.m!.collections.filter(c => !c.done);
    // Parents first; inaccessible/missing parents are surfaced rather than flattened.
    const processed = new Set<number>();
    while (pending.length) {
      const index = pending.findIndex(c => !c.source.parent?.$id || this.m!.collections.some(p => p.source._id === c.source.parent!.$id && (p.done || p.created || processed.has(p.source._id))));
      if (index === -1) { pending.forEach(c => c.error = "Collection parent is missing or the hierarchy contains a cycle."); break; }
      const c = pending.splice(index, 1)[0]; this.check();
      this.report("Creating collections", c.source.title);
      try {
        const parent = c.source.parent?.$id ? this.m!.collections.find(p => p.source._id === c.source.parent!.$id) : undefined;
        if (c.source.parent?.$id && !parent?.done && !parent?.created) throw new Error("Parent collection has not been migrated. Retry after its failure is resolved.");
        let iconError: string | undefined;
        if (c.icon) {
          try { await this.asset(c.icon); }
          catch (e) { if (e instanceof Paused || e instanceof MigrationAuthError) throw e; iconError = `Icon: ${(e as Error).message}`; }
          await this.saveIndex();
        }
        const source = c.source;
        const color = typeof source.color === "string" ? (source.color.startsWith("#") ? source.color : `#${source.color}`) : undefined;
        await this.api({ action: "collection", folder: c.folder, config: c.config, data: { name: source.title.slice(0, 200) || "Untitled collection", parentId: parent?.folder ?? this.m!.rootId,
          order: -(source.sort ?? 0), view: ["grid", "masonry"].includes(source.view || "") ? "grid" : "list", ...(color && /^#[0-9a-f]{6}$/i.test(color) ? { color } : {}), ...(c.icon?.done ? { iconFileId: c.icon.id } : {}) } });
        c.created = true; c.done = !iconError;
        if (iconError) c.error = iconError; else delete c.error;
      } catch (e) { if (e instanceof Paused || e instanceof MigrationAuthError) throw e; c.error = (e as Error).message; }
      processed.add(c.source._id); await this.saveIndex(); this.report("Creating collections", c.source.title);
    }
  }
  private async items() {
    for (const plan of this.m!.pages) {
      this.check();
      const page = await this.page(plan);
      for (const item of page.items) {
        if (item.done) continue;
        this.check(); this.report("Migrating bookmarks", item.source.title || item.source.link);
        try {
          const parent = this.m!.collections.find(c => c.source._id === item.source.collection.$id);
          if (!parent?.done && !parent?.created) throw new Error("Collection has not been migrated. Retry after its failure is resolved.");
          if (item.error && !item.assets.length) {
            const planned = itemAssets(item.source), ids = await this.ids(planned.length);
            item.assets = planned.map(a => ({ ...a, id: ids.shift()! })); await this.savePage(plan, page);
          }
          const errors: string[] = [];
          for (const a of item.assets) {
            try { await this.asset(a); }
            catch (e) { if (e instanceof Paused || e instanceof MigrationAuthError) throw e; errors.push(`${a.name}: ${(e as Error).message}`); }
            await this.savePage(plan, page);
          }
          if (!item.source.file || item.assets.some(a => a.url === item.source.link && a.done)) {
            await this.api({ action: "bookmark", id: item.id, parentId: parent.folder, data: importedBookmark(item, this.m!.accountId) });
          }
          item.done = !errors.length;
          if (errors.length) item.error = errors.join("; "); else delete item.error;
        } catch (e) { if (e instanceof Paused || e instanceof MigrationAuthError) throw e; item.error = (e as Error).message; }
        await this.savePage(plan, page);
      }
      await this.saveIndex();
    }
  }
  async run(): Promise<{ migration?: Migration; failures: string[] }> {
    try {
      await this.initialize();
      if (!this.m!.discovered) await this.discover();
      await this.collections(); await this.items();
      this.m!.status = migrationProgress(this.m!, "").failed ? "incomplete" : "complete";
      await this.saveIndex();
      this.report(this.m!.status === "complete" ? "Complete" : "Incomplete", this.m!.status === "complete" ? "Your Raindrop library has been copied to Drive." : "Retry failed items to finish migration.");
    } catch (e) {
      if (this.m) { this.m.status = "paused"; await this.saveIndex(); }
      if (!(e instanceof Paused)) throw e;
      this.report("Paused", "Progress saved. Resume when you’re ready.");
    }
    const failures = this.m?.collections.filter(c => c.error).map(c => `${c.source.title}: ${c.error}`) ?? [];
    if (this.m) for (const plan of this.m.pages) if (plan.ready && plan.failed) {
      const page = await this.page(plan); failures.push(...page.items.filter(i => i.error).map(i => `${i.source.title || i.source.link}: ${i.error}`));
    }
    return { migration: this.m, failures };
  }
}
