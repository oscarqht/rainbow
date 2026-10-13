"use client";
import { useEffect, useState } from "react";
import { storeTokens } from "@/lib/auth-client";
import type { Tokens } from "@/lib/types";
// Share a single promise across Strict Mode's effect replay: the handoff is consumed once.
let handoff: Promise<Tokens> | undefined;
function finish() {
  handoff ??= fetch("/api/auth/complete", { method: "POST", cache: "no-store" }).then(async response => {
    if (!response.ok) throw new Error("Your connection could not be completed. Please try again.");
    return await response.json() as Tokens;
  });
  return handoff;
}
export default function CompleteAuth() {
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    finish().then(tokens => { if (active) { storeTokens(tokens); window.location.replace("/"); } }).catch(() => { if (active) setError("Your connection could not be completed. Please try again."); });
    return () => { active = false; };
  }, []);
  return <main style={{ minHeight: "100vh", display: "grid", placeContent: "center", gap: "1rem", textAlign: "center" }}><h1>Rainbow</h1><p role="status">{error || "Connecting your private library…"}</p>{error && <a href="/api/auth/start">Connect Google Drive again</a>}</main>;
}
