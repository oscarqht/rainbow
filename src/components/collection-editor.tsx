"use client";
import { useState } from "react";
import { ImagePlus, Loader2, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { PrivateImage } from "./private-image";
import { descendantIds } from "@/lib/view";
import type { Collection, CollectionInput } from "@/lib/types";
type Props = { collection?: Collection; collections: Collection[]; rootId: string; parentId: string; onClose: () => void; onSave: (input: CollectionInput, existing?: Collection) => Promise<Collection>; onDelete: (collection: Collection) => Promise<void>; uploadImage: (file: File) => Promise<string>; busy: boolean };
export function CollectionEditor({ collection, collections, rootId, parentId, onClose, onSave, onDelete, uploadImage, busy }: Props) {
  const [name, setName] = useState(collection?.name ?? "");
  const [parent, setParent] = useState(collection?.parentId ?? parentId);
  const [color, setColor] = useState(collection?.color ?? "#759284");
  const [view, setView] = useState<"grid" | "list">(collection?.view ?? "grid");
  const [order, setOrder] = useState(collection?.order ?? collections.length);
  const [iconId, setIconId] = useState(collection?.iconFileId);
  const [icon, setIcon] = useState<File>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const excluded = collection ? descendantIds(collections, collection.id) : new Set<string>();
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setSaving(true); setError("");
    try {
      let id = iconId; if (icon) { id = await uploadImage(icon); setIconId(id); setIcon(undefined); }
      await onSave({ name: name.trim(), parentId: parent, color, view, order, ...(id ? { iconFileId: id } : {}) }, collection); onClose();
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to save collection."); } finally { setSaving(false); }
  };
  const remove = async () => {
    if (!collection || !window.confirm(`Move “${collection.name}” and all its contents to Trash? Restore them through Google Drive.`)) return;
    setSaving(true); try { await onDelete(collection); onClose(); } catch (err) { setError(err instanceof Error ? err.message : "Unable to delete."); } finally { setSaving(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !saving) onClose(); }}><DialogContent onPointerDownOutside={e => e.preventDefault()}>
    <DialogTitle className="dialog-title">{collection ? "Edit collection" : "A new home for your finds"}</DialogTitle>
    <DialogDescription className="dialog-description">Keep related ideas together. Nest collections to make them your own.</DialogDescription>
    <form onSubmit={save} className="editor-form">
      <label>Name<input autoFocus required maxLength={200} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Weekend reading" disabled={!!collection?.system} /></label>
      <label>Inside<select value={parent} disabled={!!collection?.system} onChange={e => setParent(e.target.value)}><option value={rootId}>My collections</option>{collections.filter(c => !excluded.has(c.id) && !c.system).map(c => <option value={c.id} key={c.id}>{c.name}</option>)}</select></label>
      <label>Folder color<div className="color-options">{["#759284", "#e4a464", "#7c91b3", "#d08a80", "#9d88a7", "#b3a368"].map(c => <button key={c} type="button" aria-label={`Color ${c}`} aria-pressed={c === color} style={{ background: c }} className={c === color ? "color-dot selected" : "color-dot"} onClick={() => setColor(c)} />)}</div></label>
      <div className="form-columns"><label>Default view<select value={view} onChange={e => setView(e.target.value as "grid" | "list")}><option value="grid">Grid</option><option value="list">List</option></select></label><label>Display order<input type="number" min={0} max={100000} value={order} onChange={e => setOrder(Number(e.target.value))} /></label></div>
      <div className="cover-field">{iconId && <PrivateImage fileId={iconId} className="folder-icon-preview" />}<label className="upload-button"><ImagePlus size={17} />{icon ? icon.name : "Upload a custom icon"}<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={e => setIcon(e.target.files?.[0])} /></label>{iconId && <Button variant="ghost" type="button" onClick={() => { setIconId(undefined); setIcon(undefined); }}>Remove</Button>}</div>
      {error && <p role="alert" className="form-error">{error}</p>}
      <div className="dialog-footer">{collection && !collection.system && <Button variant="ghost" size="icon" type="button" aria-label="Delete collection" disabled={saving || busy} onClick={() => void remove()}><Trash2 size={18} /></Button>}<div className="footer-actions"><Button variant="secondary" type="button" disabled={saving} onClick={onClose}>Cancel</Button><Button disabled={saving || busy}>{saving && <Loader2 size={16} className="spin" />} {saving ? "Saving…" : "Save collection"}</Button></div></div>
    </form>
  </DialogContent></Dialog>;
}
