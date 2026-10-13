"use client";
import { useEffect, useRef, useState } from "react";
import { Loader2, Pause, Play } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { RaindropMigration } from "@/lib/raindrop-migration";
import type { MigrationProgress } from "@/lib/raindrop-migration-model";
import type { Library } from "@/lib/types";

type Props = { ownerId: string; library: Library; onClose: () => void; runMigration: (fn: () => Promise<void>) => Promise<void> };
const size = (n: number) => n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
export function RaindropMigrationDialog({ ownerId, library, onClose, runMigration }: Props) {
  const [token, setToken] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<MigrationProgress>();
  const [failures, setFailures] = useState<string[]>([]);
  const [error, setError] = useState("");
  const paused = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; paused.current = true; }; }, []);
  useEffect(() => {
    if (!running) return;
    const unload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [running]);
  const start = async () => {
    paused.current = false; setRunning(true); setError(""); setFailures([]);
    try {
      await runMigration(async () => {
        const execute = async () => {
          const result = await new RaindropMigration({ ownerId, library, token: token.trim(), paused: () => paused.current,
            progress: p => { if (mounted.current) setProgress(p); },
          }).run();
          if (mounted.current) setFailures(result.failures);
        };
        if (navigator.locks) await navigator.locks.request(`rainbow-raindrop-${ownerId}-${library.rootId}`, { ifAvailable: true }, async lock => {
          if (!lock) throw new Error("Migration is already running in another tab. Pause it there before resuming here.");
          await execute();
        }); else await execute();
      });
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "Migration stopped. Resume to retry."); }
    finally { if (mounted.current) setRunning(false); }
  };
  const total = (progress?.collectionTotal ?? 0) + (progress?.bookmarkTotal ?? 0);
  const completed = (progress?.collections ?? 0) + (progress?.bookmarks ?? 0);
  const complete = progress?.phase === "Complete" && !error;
  return <Dialog open onOpenChange={open => { if (!open && !running) onClose(); }}><DialogContent onEscapeKeyDown={e => { if (running) e.preventDefault(); }} onPointerDownOutside={e => e.preventDefault()}>
    <DialogTitle className="dialog-title">Migrate from Raindrop</DialogTitle>
    <DialogDescription className="dialog-description">Copy your collections, links, files, icons, and covers into your Google Drive.</DialogDescription>
    <div className="editor-form migration-form">
      <label>Raindrop API token<input type="password" autoComplete="off" spellCheck={false} maxLength={8192} value={token} disabled={running} onChange={e => setToken(e.target.value)} placeholder="Paste your Raindrop token" /></label>
      <p className="settings-small">Your token stays in memory. Re-enter it after reopening this tab to resume saved progress. Raindrop content is read only; Trash is excluded.</p>
      <p className="settings-small">Keep this tab open while migrating. Closing it pauses the migration after the current operation. Progress is saved in Drive.</p>
      {progress && <div className="migration-progress" role="status" aria-live="polite" aria-atomic="true">
        <strong>{running && <Loader2 size={16} className="spin" />} {error ? "Paused · action needed" : progress.phase}</strong>
        <progress aria-label="Migration progress" max={Math.max(1, total)} value={progress.discovering ? undefined : completed} />
        <div className="migration-counts"><span>Collections: {progress.collections} / {progress.collectionTotal}</span><span>Bookmarks: {progress.bookmarks} / {progress.bookmarkTotal}{progress.discovering ? "+" : ""}</span><span>Failed: {progress.failed}</span></div>
        <p>{progress.current}</p>
        {progress.bytes !== undefined && <div className="migration-transfer"><progress aria-label="File transfer progress" max={Math.max(1, progress.totalBytes ?? progress.bytes)} value={progress.totalBytes === undefined ? undefined : progress.bytes} /><small>{size(progress.bytes)}{progress.totalBytes !== undefined ? ` / ${size(progress.totalBytes)}` : " transferred"}</small></div>}
      </div>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {!!failures.length && <details className="migration-failures" open><summary>{failures.length} failed items · migration incomplete</summary><ul>{failures.map((failure, i) => <li key={i}>{failure}</li>)}</ul></details>}
      <div className="editor-actions">
        <Button variant="ghost" disabled={running} onClick={onClose}>Close</Button>
        {running ? <Button variant="secondary" onClick={() => { paused.current = true; setProgress(p => p ? { ...p, phase: "Pausing", current: "Finishing the current operation and saving progress…" } : p); }}><Pause size={16} />Pause</Button> : !complete && <Button disabled={!token.trim()} onClick={() => void start()}><Play size={16} />{failures.length ? "Retry failed items" : progress ? "Resume migration" : "Start / resume migration"}</Button>}
      </div>
    </div>
  </DialogContent></Dialog>;
}
