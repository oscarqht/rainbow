"use client";
import { useState } from "react";
import { ExternalLink, ImagePlus, Loader2, Trash2, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { BookmarkLink } from "./bookmark-link";
import { PrivateImage } from "./private-image";
import { validateFile } from "@/lib/library";
import type { Bookmark, BookmarkData, Collection } from "@/lib/types";
type Props = { bookmark?: Bookmark; collections: Collection[]; parentId: string; onClose: () => void; onSave: (data: BookmarkData, parentId: string, existing?: Bookmark) => Promise<Bookmark>; onDelete: (bookmark: Bookmark) => Promise<void>; uploadImage: (file: File) => Promise<string>; uploadFile: (file: File) => Promise<string>; busy: boolean };
export function BookmarkEditor({ bookmark, collections, parentId, onClose, onSave, onDelete, uploadImage, uploadFile, busy }: Props) {
  const [kind, setKind] = useState(bookmark?.file ? "file" : "link");
  const [file, setFile] = useState<File>();
  const [attachment, setAttachment] = useState(bookmark?.file);
  const [url, setUrl] = useState(bookmark?.url ?? "");
  const [title, setTitle] = useState(bookmark?.title ?? "");
  const [description, setDescription] = useState(bookmark?.description ?? "");
  const [note, setNote] = useState(bookmark?.note ?? "");
  const [tags, setTags] = useState(bookmark?.tags.join(", ") ?? "");
  const [collection, setCollection] = useState(bookmark?.parentId ?? parentId);
  const [coverId, setCoverId] = useState(bookmark?.coverFileId);
  const [cover, setCover] = useState<File>();
  const [removeCover, setRemoveCover] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setError(""); setSaving(true);
    try {
      let uploaded = attachment;
      let imageId = coverId;
      let useCover = !removeCover;
      if (kind === "file") {
        if (file) {
          validateFile(file);
          const id = await uploadFile(file);
          uploaded = { id, name: file.name, mimeType: file.type || "application/octet-stream" };
          setAttachment(uploaded); setFile(undefined);
          imageId = file.type.startsWith("image/") ? id : undefined;
          setCoverId(imageId); setRemoveCover(false); useCover = true;
        }
        if (!uploaded) throw new Error("Choose a file to upload.");
      }
      if (cover) { imageId = await uploadImage(cover); setCoverId(imageId); setCover(undefined); }
      const parsed = new URL(kind === "file" ? `https://drive.google.com/file/d/${uploaded!.id}/view` : url.trim()); if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Use an http:// or https:// link.");
      await onSave({ schemaVersion: 1, ...(bookmark?.raindrop ? { raindrop: bookmark.raindrop } : {}), ...(kind === "file" ? { file: uploaded } : {}), url: parsed.href, title: title.trim(), description: description.trim(), note, tags: [...new Set(tags.split(",").map(t => t.trim()).filter(Boolean))], ...(useCover && imageId ? { coverFileId: imageId } : {}) }, collection, bookmark);
      onClose();
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to save this bookmark."); }
    finally { setSaving(false); }
  };
  const remove = async () => {
    if (!bookmark || !window.confirm("Move this bookmark to Trash? You can restore the file from Google Drive.")) return;
    setSaving(true); try { await onDelete(bookmark); onClose(); } catch (err) { setError(err instanceof Error ? err.message : "Unable to delete."); } finally { setSaving(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !saving) onClose(); }}><DialogContent onEscapeKeyDown={event => { if (saving) event.preventDefault(); }} onPointerDownOutside={event => event.preventDefault()}>
    <DialogTitle className="dialog-title">{bookmark ? "Edit bookmark" : "Save something good"}</DialogTitle>
    <DialogDescription className="dialog-description">A little inspiration, tucked away for later.</DialogDescription>
    <form onSubmit={save} className="editor-form">
      {!bookmark && <div className="bookmark-kind" role="group" aria-label="Bookmark type">{["link", "file"].map(value => <Button key={value} type="button" variant={kind === value ? "default" : "secondary"} aria-pressed={kind === value} disabled={saving} onClick={() => setKind(value)}>{value === "link" ? "Link" : "File"}</Button>)}</div>}
      <fieldset disabled={saving} className="bookmark-fields">
      {kind === "link" ? <label>Link<input autoFocus type="url" required maxLength={8192} placeholder="https://…" value={url} onChange={e => setUrl(e.target.value)} /></label> : <label>File<input type="file" required={!attachment} onChange={e => { const next = e.target.files?.[0]; setFile(next); if (next && !title) setTitle(next.name); }} /><small>{file?.name ?? attachment?.name ?? "Choose a file up to 50 MB. Images become their own cover."}</small></label>}
      <label>Title<input required={!!bookmark || kind === "file"} maxLength={500} placeholder={!bookmark && kind === "link" ? "Leave blank to fetch from the link" : "Give it a memorable name"} value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label>Description<textarea rows={2} maxLength={5000} placeholder="What makes this worth keeping?" value={description} onChange={e => setDescription(e.target.value)} /></label>
      <div className="form-columns"><label>Collection<select value={collection} onChange={e => setCollection(e.target.value)}>{collections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label>Tags<input maxLength={2000} placeholder="design, reading, inspiration" value={tags} onChange={e => setTags(e.target.value)} /><small>Separate tags with commas.</small></label></div>
      <label>Note<textarea rows={3} maxLength={10000} placeholder="Your thoughts, reminders, and little discoveries…" value={note} onChange={e => setNote(e.target.value)} /></label>
      <div className="cover-field">{!removeCover && (coverId || bookmark?.demoCover) && <PrivateImage fileId={coverId} fallback={bookmark?.demoCover} className="cover-preview" />}
        <label className="upload-button"><ImagePlus size={17} />{cover ? cover.name : "Upload a cover"}<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={e => { setCover(e.target.files?.[0]); setRemoveCover(false); }} /></label>
        {(coverId || cover) && <Button type="button" variant="ghost" size="icon" aria-label="Remove cover" onClick={() => { setCoverId(undefined); setCover(undefined); setRemoveCover(true); }}><X size={16} /></Button>}
      </div>
      </fieldset>
      {error && <p className="form-error" role="alert">{error} Your draft is still here. Refresh the library and reopen this bookmark to review the latest version; copy your draft first.</p>}
      <div className="dialog-footer">{bookmark && <><Button type="button" variant="ghost" size="icon" aria-label="Delete bookmark" disabled={saving || busy} onClick={() => void remove()}><Trash2 size={18} /></Button><BookmarkLink bookmark={bookmark} className="open-link">{bookmark.file ? "Open file" : "Open link"} <ExternalLink size={13} /></BookmarkLink></>}
        <div className="footer-actions"><Button type="button" variant="secondary" disabled={saving} onClick={onClose}>Cancel</Button><Button disabled={saving || busy || !collection}>{saving && <Loader2 size={16} className="spin" />} {saving ? "Saving…" : "Save bookmark"}</Button></div>
      </div>
    </form>
  </DialogContent></Dialog>;
}
