"use client";
export default function ErrorPage({ reset }: { reset: () => void }) { return <main className="fatal"><h1>Something interrupted Rainbow.</h1><p>Your saved library remains in Google Drive.</p><button className="button button-primary" onClick={reset}>Try again</button></main>; }
