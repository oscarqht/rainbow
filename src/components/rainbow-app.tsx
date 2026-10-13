"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowDownAZ, ArrowUpRight, Bookmark as BookmarkIcon, Check, ChevronDown, ChevronRight, Cloud, Folder, FolderPlus, Grid2X2, Hash, Inbox, LayoutList, Loader2, LogOut, Menu, MoreHorizontal, Plus, Search, ShieldCheck, Sparkles, Unplug, X } from "lucide-react";
import { useLibrary } from "@/hooks/use-library";
import { domain, filterBookmarks } from "@/lib/view";
import type { Bookmark, Collection } from "@/lib/types";
import { BookmarkLink } from "./bookmark-link";
import { BookmarkEditor } from "./bookmark-editor";
import { CollectionEditor } from "./collection-editor";
import { PrivateImage } from "./private-image";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
function RainbowMark() { return <span className="rainbow-mark" aria-hidden="true"><i /><i /><i /></span>; }
function FolderIcon({ collection }: { collection: Collection }) { return collection.iconFileId ? <PrivateImage fileId={collection.iconFileId} className="folder-icon" /> : <Folder size={18} style={{ color: collection.color ?? "#859286" }} />; }
export function RainbowApp() {
  const app = useLibrary();
  const { library, account, ready, busy } = app;
  const [selected, setSelected] = useState("all");
  const [tag, setTag] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [viewOverride, setViewOverride] = useState<"grid" | "list" | null>(null);
  const [sort, setSort] = useState<"newest" | "title">("newest");
  const [bookmarkEditor, setBookmarkEditor] = useState<Bookmark | "new" | null>(null);
  const [collectionEditor, setCollectionEditor] = useState<Collection | "new" | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [mobileOpen, setMobileOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [notice, setNotice] = useState("");
  const [accountBusy, setAccountBusy] = useState(false);
  useEffect(() => {
    const authFailed = new URLSearchParams(window.location.search).has("auth_error");
    if (authFailed) window.history.replaceState(null, "", "/");
    fetch("/api/auth/status").then(r => r.json()).then(data => setConfigured(data.configured)).catch(() => setConfigured(false))
      .finally(() => { if (authFailed) setNotice("Google connection was not completed. Please try again."); });
  }, []);
  const collection = library.collections.find(c => c.id === app.resolveCollectionId(selected));
  const effectiveSelected = collection?.id ?? "all";
  const view = viewOverride ?? collection?.view ?? "grid";
  const visible = useMemo(() => filterBookmarks(library.bookmarks, effectiveSelected, tag, search).sort((a, b) => sort === "title" ? a.title.localeCompare(b.title) : b.modifiedTime.localeCompare(a.modifiedTime)), [library.bookmarks, effectiveSelected, tag, search, sort]);
  const tags = useMemo(() => [...new Set(library.bookmarks.flatMap(b => b.tags))].sort((a, b) => a.localeCompare(b)), [library.bookmarks]);
  const subcollections = library.collections.filter(c => c.parentId === effectiveSelected && !c.system).sort((a,b) => a.order - b.order);
  const navigate = (id: string) => { setSelected(id); setTag(null); setSearch(""); setViewOverride(null); setMobileOpen(false); };
  const selectTag = (value: string) => { setTag(value === tag ? null : value); setSelected("all"); setMobileOpen(false); };
  const connect = () => { if (configured) window.location.assign("/api/auth/start"); else setSettings(true); };
  const toggleCollapsed = (id: string) => setCollapsed(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const collectionRows = (parent: string, depth = 0, ancestors = new Set<string>()): React.ReactNode => {
    if (depth > 30) return null;
    return library.collections.filter(c => c.parentId === parent && !c.system && !ancestors.has(c.id)).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)).map(c => {
      const children = library.collections.some(item => item.parentId === c.id);
      const nextAncestors = new Set(ancestors); nextAncestors.add(c.id);
      return <div key={c.id}><div className={`collection-row ${effectiveSelected === c.id ? "active" : ""}`} style={{ paddingLeft: 8 + depth * 16 }}>
        {children ? <button className="tree-toggle" aria-label={`${collapsed.has(c.id) ? "Expand" : "Collapse"} ${c.name}`} aria-expanded={!collapsed.has(c.id)} onClick={() => toggleCollapsed(c.id)}>{collapsed.has(c.id) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</button> : <span className="tree-spacer" />}
        <button className="collection-select" onClick={() => navigate(c.id)}><FolderIcon collection={c} /><span>{c.name}</span><small>{library.bookmarks.filter(b => b.parentId === c.id).length}</small></button>
        <button className="collection-more" aria-label={`Edit ${c.name}`} disabled={busy} onClick={() => setCollectionEditor(c)}><MoreHorizontal size={16} /></button>
      </div>{!collapsed.has(c.id) && collectionRows(c.id, depth + 1, nextAncestors)}</div>;
    });
  };
  const leave = async (revoke: boolean) => { setAccountBusy(true); setNotice(""); try { await app.signOut(revoke); setSettings(false); navigate("all"); } catch (err) { setNotice(err instanceof Error ? err.message : "Unable to disconnect."); } finally { setAccountBusy(false); } };
  return <div className="app-shell">
    {mobileOpen && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}
    <aside className={`sidebar ${mobileOpen ? "sidebar-open" : ""}`}>
      <Link className="brand" href="/" aria-label="Rainbow home"><RainbowMark /><span>rainbow<span className="brand-dot">.</span></span></Link>
      <div className="workspace-label">YOUR LITTLE CORNER OF THE WEB</div>
      <nav aria-label="Library"><button className={`nav-item ${effectiveSelected === "all" && !tag ? "active" : ""}`} onClick={() => navigate("all")}><BookmarkIcon size={18} /><span>All bookmarks</span><small>{library.bookmarks.length}</small></button><button className={`nav-item ${effectiveSelected === library.unsortedId ? "active" : ""}`} onClick={() => navigate(library.unsortedId)}><Inbox size={18} /><span>Unsorted</span><small>{library.bookmarks.filter(b => b.parentId === library.unsortedId).length}</small></button></nav>
      <div className="sidebar-section-title"><span>COLLECTIONS</span><button aria-label="New collection" title="New collection" disabled={busy || !library.rootId} onClick={() => setCollectionEditor("new")}><Plus size={16} /></button></div>
      <nav aria-label="Collections" className="collection-tree">{collectionRows(library.rootId)}</nav>
      <button className="new-collection" disabled={busy || !library.rootId} onClick={() => setCollectionEditor("new")}><FolderPlus size={16} /> New collection</button>
      <div className="sidebar-section-title tags-title"><span>TAGS</span><Hash size={14} /></div>
      <div className="sidebar-tags">{tags.length ? tags.map(t => <button key={t} className={tag === t ? "tag-filter selected" : "tag-filter"} onClick={() => selectTag(t)}><Hash size={12} />{t}</button>) : <p className="sidebar-hint">Add tags to find your favorites faster.</p>}</div>
      <div className="sidebar-bottom"><div className="privacy-note"><ShieldCheck size={18} /><span>{account ? "Yours. Always private." : "Your bookmarks belong to you."}<small>{account ? "Stored in your Google Drive" : "Connect your own Google Drive"}</small></span></div>
        <button className="account-button" onClick={() => setSettings(true)}><span className="avatar">{account ? account.name.charAt(0).toUpperCase() : "R"}</span><span>{account?.name ?? "Demo workspace"}<small>{account?.email ?? "Explore Rainbow"}</small></span><MoreHorizontal size={18} /></button>
      </div>
    </aside>
    <div className="main-shell"><header className="topbar"><button className="mobile-menu" aria-label="Open navigation" onClick={() => setMobileOpen(true)}><Menu size={22} /></button><div className="breadcrumb">My library <ChevronRight size={13} /><span>{collection?.name ?? "All bookmarks"}</span></div><div className="topbar-actions"><span className={`sync-label ${busy ? "is-syncing" : ""}`} role="status">{busy ? <Loader2 size={15} className="spin" /> : account ? <Cloud size={15} /> : <Sparkles size={15} />}{busy ? "Syncing your finds…" : account ? "Saved in Drive" : "Demo mode"}</span>{account ? <Button size="icon" variant="ghost" aria-label="Sync with Google Drive" title="Sync with Google Drive" disabled={busy} onClick={() => void app.sync()}><Cloud size={18} /></Button> : <Button variant="secondary" size="sm" onClick={connect}><Cloud size={16} />Connect Drive</Button>}</div></header>
      <main className="library-main"><section className="page-heading"><div><div className="eyebrow"><span /> A HOME FOR WHAT INSPIRES YOU</div><h1>{tag ? `# ${tag}` : collection?.name ?? "Your good finds."}</h1><p>{collection ? "A collection of things worth coming back to." : "The ideas, places, and little discoveries you want to keep."}</p></div><Button disabled={busy || !ready || !library.unsortedId} onClick={() => setBookmarkEditor("new")}><Plus size={18} />Add bookmark</Button></section>
        {!account && ready && <div className="demo-banner"><div><span className="demo-dot" /><strong>A little preview of your next favorite space.</strong><span> Demo changes stay on this device.</span></div><button onClick={connect}>Make it yours <ArrowUpRight size={15} /></button></div>}
        {(app.error || app.cacheWarning || notice) && <div className="error-banner" role="alert"><span>{app.error || notice || app.cacheWarning}</span>{account && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void app.sync()}>Retry sync</Button>}</div>}
        <div className="library-toolbar"><label className="search-box"><Search size={17} /><input aria-label="Search bookmarks" placeholder="Search your bookmarks…" value={search} onChange={e => setSearch(e.target.value)} />{search && <button aria-label="Clear search" onClick={() => setSearch("")}><X size={15} /></button>}</label><div className="toolbar-controls"><label className="sort-control"><ArrowDownAZ size={16} /><select aria-label="Sort bookmarks" value={sort} onChange={e => setSort(e.target.value as "newest" | "title")}><option value="newest">Recently saved</option><option value="title">Title A–Z</option></select></label><div className="view-switch"><button aria-label="Grid view" aria-pressed={view === "grid"} onClick={() => setViewOverride("grid")}><Grid2X2 size={17} /></button><button aria-label="List view" aria-pressed={view === "list"} onClick={() => setViewOverride("list")}><LayoutList size={18} /></button></div></div></div>
        {subcollections.length > 0 && <div className="subcollections">{subcollections.map(c => <button key={c.id} onClick={() => navigate(c.id)}><FolderIcon collection={c} />{c.name}<ChevronRight size={13} /></button>)}</div>}
        <div className="results-caption"><span>{visible.length} {visible.length === 1 ? "bookmark" : "bookmarks"}{search && ` matching “${search}”`}</span>{tag && <button onClick={() => setTag(null)}>Clear tag filter <X size={12} /></button>}</div>
        {!ready ? null : busy && !library.bookmarks.length && !library.collections.length ? <div className="empty-state"><Loader2 size={30} className="spin" /><h2>Gathering your good finds…</h2><p>Loading your private library.</p></div> : visible.length === 0 ? <div className="empty-state"><BookmarkIcon size={30} /><h2>{search || tag ? "No finds just yet." : "Start your collection of good things."}</h2><p>{search || tag ? "Try a different search or clear your filters." : "Save a link or file, add a little context, and make it yours."}</p><Button variant="secondary" disabled={busy || !library.unsortedId} onClick={() => search || tag ? (setSearch(""), setTag(null)) : setBookmarkEditor("new")}>{search || tag ? "Clear filters" : "Add your first bookmark"}</Button></div> : <div className={`bookmark-layout ${view === "list" ? "list-layout" : "grid-layout"}`}>{visible.map(b => <article className="bookmark-card" key={b.id}>
          <button className="card-cover" disabled={b.version === "0"} aria-label={`Edit ${b.title}`} onClick={() => setBookmarkEditor(b)}>{b.coverFileId || b.demoCover ? <PrivateImage fileId={b.coverFileId} fallback={b.demoCover} className="bookmark-cover" /> : <div className="cover-placeholder"><BookmarkIcon size={32} /><span>{(b.file ? "File" : domain(b.url))}</span></div>}<span className="cover-edit"><MoreHorizontal size={19} /></span></button>
          <div className="card-body"><div className="card-source"><span className="source-letter">{(b.file ? "File" : domain(b.url)).charAt(0).toUpperCase()}</span>{(b.file ? "File" : domain(b.url))}<BookmarkLink bookmark={b} title={b.file ? `Open ${b.file.name}` : "Open original link"} aria-label={`Open ${b.title}`}><ArrowUpRight size={14} /></BookmarkLink></div><button className="card-title" disabled={b.version === "0"} onClick={() => setBookmarkEditor(b)}>{b.title}</button><p>{b.description || "A little discovery, saved for later."}</p><div className="card-tags">{b.tags.slice(0, 3).map(t => <button key={t} onClick={() => selectTag(t)}>{t}</button>)}{b.tags.length > 3 && <span>+{b.tags.length - 3}</span>}</div><div className="card-footer"><span><Folder size={12} />{library.collections.find(c => c.id === b.parentId)?.name ?? "Collection"}</span><button disabled={b.version === "0"} aria-label={`Edit bookmark ${b.title}`} onClick={() => setBookmarkEditor(b)}><MoreHorizontal size={17} /></button></div></div>
        </article>)}</div>}
        <footer className="library-footer"><RainbowMark /><span>A little less scrolling. A little more discovering.</span><span className="footer-private"><ShieldCheck size={13} />{account ? "Private by design" : "Built for your Google Drive"}</span></footer>
      </main>
    </div>
    {app.toast && <div className="error-toast" role="alert"><span>{app.toast}</span><button aria-label="Dismiss notification" onClick={app.dismissToast}><X size={15} /></button></div>}
    {bookmarkEditor && <BookmarkEditor key={bookmarkEditor === "new" ? "new-bookmark" : bookmarkEditor.id} bookmark={bookmarkEditor === "new" ? undefined : bookmarkEditor} collections={library.collections} parentId={effectiveSelected === "all" ? library.unsortedId : effectiveSelected} onClose={() => setBookmarkEditor(null)} onSave={app.saveBookmark} onDelete={app.trashBookmark} uploadFile={app.uploadFile} uploadImage={app.uploadImage} busy={busy} />}
    {collectionEditor && <CollectionEditor key={collectionEditor === "new" ? "new-collection" : collectionEditor.id} collection={collectionEditor === "new" ? undefined : collectionEditor} collections={library.collections} rootId={library.rootId} parentId={effectiveSelected === "all" || collection?.system ? library.rootId : effectiveSelected} onClose={() => setCollectionEditor(null)} onSave={app.saveCollection} onDelete={app.trashCollection} uploadImage={app.uploadImage} busy={busy} />}
    <Dialog open={settings} onOpenChange={setSettings}><DialogContent><DialogTitle className="dialog-title">{account ? "Your private workspace" : "Make yourself at home."}</DialogTitle><DialogDescription className="dialog-description">Rainbow keeps your collections, bookmarks, and images in your own Google Drive.</DialogDescription><div className="settings-content"><div className="settings-feature"><ShieldCheck size={21} /><div><strong>Your Drive. Your data.</strong><p>Rainbow accesses files it creates or you explicitly authorize. Your collections are never shared publicly by Rainbow.</p></div></div>
      {account ? <><div className="connected-account"><span className="avatar">{account.name.charAt(0)}</span><div><strong>{account.name}</strong><p>{account.email}</p></div><Check size={19} /></div><p className="settings-small">Signing out clears this browser’s tokens and library cache. Disconnecting also revokes Google access. Your saved files remain in Drive.</p><Button variant="secondary" disabled={accountBusy || busy} onClick={() => void leave(false)}><LogOut size={17} />Sign out</Button><Button variant="ghost" disabled={accountBusy || busy} onClick={() => void leave(true)}>{accountBusy ? <Loader2 className="spin" size={17} /> : <Unplug size={17} />}Disconnect Google</Button></> : configured ? <><p>Connect to start your own library. Demo bookmarks won’t be copied into your Drive.</p><Button onClick={connect}><Cloud size={18} />Connect Google Drive</Button></> : <><div className="setup-note"><strong>Google connection needs configuration</strong><p>Add your Google OAuth credentials to the server’s environment and register its callback URL. The setup steps are in the project README.</p></div><Button variant="secondary" onClick={() => setSettings(false)}>Explore the demo</Button></>}
      {notice && <p className="form-error" role="alert">{notice}</p>}
    </div></DialogContent></Dialog>
  </div>;
}
