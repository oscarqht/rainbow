"use client";
import dynamic from "next/dynamic";
// The library lives in this browser (tokens in localStorage, cache in IndexedDB), so skip server rendering:
// the first paint is the real cached state instead of a placeholder waiting for hydration.
export const RainbowClient = dynamic(() => import("./rainbow-app").then(m => m.RainbowApp), { ssr: false, loading: () => <div className="app-boot" aria-busy="true" /> });
