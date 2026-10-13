import type { Tokens } from "./types";

const TOKEN_KEY = "rainbow_tokens_v1";
let refreshing: Promise<string> | undefined;
export class AuthError extends Error {
  constructor(message: string, public reconnect = false) { super(message); this.name = "AuthError"; }
}
export function loadTokens(): Tokens | null {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(localStorage.getItem(TOKEN_KEY) || "null") as Tokens | null;
    return value && typeof value.accessToken === "string" && !!value.accessToken && typeof value.refreshToken === "string" && !!value.refreshToken && typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt) && typeof value.accountId === "string" && !!value.accountId && typeof value.email === "string" && typeof value.name === "string" ? value : null;
  } catch { return null; }
}
export function storeTokens(tokens: Tokens) {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
  window.dispatchEvent(new Event("rainbow-auth"));
}
export function clearTokens() {
  localStorage.removeItem(TOKEN_KEY);
  window.dispatchEvent(new Event("rainbow-auth"));
}
async function refresh(force: boolean, originalAccessToken: string): Promise<string> {
  const tokens = loadTokens();
  if (!tokens) throw new AuthError("Connect Google Drive to continue.", true);
  // Another tab may have refreshed while this one was waiting for the lock.
  if ((!force || tokens.accessToken !== originalAccessToken) && tokens.expiresAt > Date.now() + 60000) return tokens.accessToken;
  let response: Response;
  try {
    response = await fetch("/api/auth/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken: tokens.refreshToken }), cache: "no-store", signal: AbortSignal.timeout(20000) });
  } catch { throw new AuthError("Google Drive is temporarily unavailable. Try again."); }
  let data: { error?: string; accessToken?: string; refreshToken?: string; expiresAt?: number };
  try { data = await response.json(); } catch { throw new AuthError("Unable to renew your connection. Try again."); }
  const current = loadTokens();
  // Sign-out/account-switch wins over an in-flight refresh; never resurrect old credentials.
  if (!current || current.accountId !== tokens.accountId || current.refreshToken !== tokens.refreshToken) throw new AuthError("Your connection changed. Try again.", !current);
  if (!response.ok) {
    if (data.error === "invalid_grant") {
      clearTokens();
      throw new AuthError("Your Google connection expired. Please reconnect.", true);
    }
    throw new AuthError("Unable to renew your Google connection. Try again.");
  }
  if (!data.accessToken || typeof data.expiresAt !== "number") throw new AuthError("Unable to renew your connection. Try again.");
  const updated = { ...current, accessToken: data.accessToken, expiresAt: data.expiresAt, refreshToken: data.refreshToken || current.refreshToken };
  storeTokens(updated);
  return updated.accessToken;
}
export async function getAccessToken(force = false): Promise<string> {
  const tokens = loadTokens();
  if (!tokens) throw new AuthError("Connect Google Drive to continue.", true);
  if (!force && tokens.expiresAt > Date.now() + 60000) return tokens.accessToken;
  if (!refreshing) {
    const operation = () => refresh(force, tokens.accessToken);
    refreshing = Promise.resolve(typeof navigator !== "undefined" && navigator.locks ? navigator.locks.request("rainbow-token-refresh", operation) : operation()).finally(() => { refreshing = undefined; });
  }
  return refreshing!;
}
export async function disconnect(): Promise<void> {
  const tokens = loadTokens();
  if (!tokens) return;
  let response: Response;
  try {
    response = await fetch("/api/auth/disconnect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken: tokens.refreshToken }), cache: "no-store", signal: AbortSignal.timeout(20000) });
  } catch { throw new AuthError("Could not disconnect Google. Try again."); }
  if (!response.ok) throw new AuthError("Could not disconnect Google. Try again.");
  clearTokens();
}
