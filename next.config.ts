import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
// Use the phase rather than NODE_ENV: Next 16 loads this file before NODE_ENV is set for `next dev`.
export default function config(phase: string): NextConfig {
  const isDev = phase === PHASE_DEVELOPMENT_SERVER;
  return {
    poweredByHeader: false,
    async headers() {
      return [{ source: "/(.*)", headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self' 'unsafe-inline'" + (isDev ? " 'unsafe-eval'" : "") + "; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' https://www.googleapis.com https://oauth2.googleapis.com https://openidconnect.googleapis.com ws://localhost:*; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" }
      ] }];
    }
  };
}
