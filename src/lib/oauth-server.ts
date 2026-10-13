import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type { Tokens } from "./types";

export const TRANSACTION_COOKIE = "rainbow_oauth";
export const HANDOFF_COOKIE = "rainbow_handoff";
export const BINDING_COOKIE = "rainbow_binding";
const scopes = ["openid", "email", "profile", "https://www.googleapis.com/auth/drive.file"];
const noCache = { "Cache-Control": "no-store", "Pragma": "no-cache", "Referrer-Policy": "no-referrer" };

export class OAuthError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}

export function config() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) throw new OAuthError("not_configured", 503);
  let url: URL;
  try { url = new URL(redirectUri); } catch { throw new OAuthError("not_configured", 503); }
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) || url.pathname !== "/api/auth/callback" || url.search || url.hash || url.username || url.password) throw new OAuthError("not_configured", 503);
  return { clientId, clientSecret, redirectUri, origin: url.origin, secure: url.protocol === "https:" };
}

export function isConfigured() { try { config(); return true; } catch { return false; } }
export function json(data: unknown, status = 200) { return NextResponse.json(data, { status, headers: noCache }); }
export function errorResponse(error: unknown) { return error instanceof OAuthError ? json({ error: error.code }, error.status) : json({ error: "temporarily_unavailable" }, 503); }
export function redirect(path: string) { return NextResponse.redirect(new URL(path, config().origin), { headers: noCache }); }

export function seal(value: unknown, purpose: string): string {
  const key = createHash("sha256").update(`rainbow:${purpose}:${config().clientSecret}`).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(purpose));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}
export function unseal<T>(value: string | undefined, purpose: string): T {
  if (!value || value.length > 8000) throw new OAuthError("invalid_session");
  try {
    const data = Buffer.from(value, "base64url");
    const key = createHash("sha256").update(`rainbow:${purpose}:${config().clientSecret}`).digest();
    const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    decipher.setAAD(Buffer.from(purpose));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8")) as T;
  } catch { throw new OAuthError("invalid_session"); }
}
export function cookie(response: NextResponse, name: string, value: string, maxAge: number) {
  response.cookies.set(name, value, { httpOnly: true, secure: config().secure, sameSite: "lax", path: "/api/auth", maxAge });
}
export function clearFlow(response: NextResponse) {
  for (const name of [TRANSACTION_COOKIE, HANDOFF_COOKIE, BINDING_COOKIE]) cookie(response, name, "", 0);
  return response;
}
export function safeEqual(a: string, b: string) {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function validateOrigin(request: Request) {
  if (request.headers.get("origin") !== config().origin) throw new OAuthError("invalid_origin", 403);
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw new OAuthError("invalid_origin", 403);
}
export async function readToken(request: Request) {
  validateOrigin(request);
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") || "")) throw new OAuthError("invalid_request", 415);
  if (Number(request.headers.get("content-length") || 0) > 12000) throw new OAuthError("invalid_request", 413);
  // Bound the stream too: Content-Length is optional and supplied by the caller.
  const reader = request.body?.getReader();
  if (!reader) throw new OAuthError("invalid_request");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 12000) { await reader.cancel(); throw new OAuthError("invalid_request", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let data: { refreshToken?: unknown };
  try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new OAuthError("invalid_request"); }
  if (!data || typeof data.refreshToken !== "string" || data.refreshToken.length < 1 || data.refreshToken.length > 8192 || /[\r\n]/.test(data.refreshToken)) throw new OAuthError("invalid_request");
  return data.refreshToken;
}

export async function googleTokens(parameters: Record<string, string>) {
  const c = config();
  let response: Response;
  try {
    response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", cache: "no-store", signal: AbortSignal.timeout(15000), headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...parameters }) });
  } catch { throw new OAuthError("temporarily_unavailable", 503); }
  let data: Record<string, unknown>;
  try { data = await response.json(); } catch { throw new OAuthError("temporarily_unavailable", 503); }
  if (!response.ok) {
    if (data.error === "invalid_grant") throw new OAuthError("invalid_grant", 401);
    if (data.error === "invalid_client") throw new OAuthError("not_configured", 503);
    throw new OAuthError("temporarily_unavailable", 503);
  }
  if (typeof data.access_token !== "string" || typeof data.expires_in !== "number" || data.expires_in <= 0 || (data.token_type as string)?.toLowerCase() !== "bearer") throw new OAuthError("invalid_token_response", 503);
  // Users can decline individual scopes at consent; never initialize Drive with a partial grant.
  if (typeof data.scope === "string" && !data.scope.split(" ").includes(scopes[3])) throw new OAuthError("drive_permission_required", 403);
  return { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000, ...(typeof data.refresh_token === "string" ? { refreshToken: data.refresh_token } : {}) };
}

export function startOAuth() {
  const c = config();
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const binding = randomBytes(24).toString("base64url");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({ client_id: c.clientId, redirect_uri: c.redirectUri, response_type: "code", scope: scopes.join(" "), access_type: "offline", prompt: "consent", state, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
  const response = clearFlow(NextResponse.redirect(url, { headers: noCache }));
  cookie(response, TRANSACTION_COOKIE, seal({ state, verifier, expiresAt: Date.now() + 600000 }, `transaction:${binding}`), 600);
  cookie(response, BINDING_COOKIE, binding, 600);
  return response;
}

export async function callbackOAuth(request: NextRequest) {
  const binding = request.cookies.get(BINDING_COOKIE)?.value;
  if (!binding) throw new OAuthError("invalid_session");
  const transaction = unseal<{ state: string; verifier: string; expiresAt: number }>(request.cookies.get(TRANSACTION_COOKIE)?.value, `transaction:${binding}`);
  const state = request.nextUrl.searchParams.get("state");
  if (!state || !safeEqual(state, transaction.state) || transaction.expiresAt < Date.now()) throw new OAuthError("invalid_session");
  if (request.nextUrl.searchParams.has("error")) throw new OAuthError("authorization_cancelled");
  const code = request.nextUrl.searchParams.get("code");
  if (!code || code.length > 8192) throw new OAuthError("invalid_request");
  const token = await googleTokens({ code, redirect_uri: config().redirectUri, grant_type: "authorization_code", code_verifier: transaction.verifier });
  if (!token.refreshToken) throw new OAuthError("offline_access_required");
  let profile: { sub?: string; email?: string; name?: string };
  try {
    const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${token.accessToken}` }, cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error();
    profile = await response.json();
  } catch { throw new OAuthError("temporarily_unavailable", 503); }
  if (typeof profile.sub !== "string" || !profile.sub) throw new OAuthError("invalid_token_response", 503);
  const tokens: Tokens = { ...token, refreshToken: token.refreshToken, accountId: profile.sub, email: profile.email || "", name: profile.name || "Google user" };
  const response = redirect("/auth/complete");
  cookie(response, TRANSACTION_COOKIE, "", 0);
  const handoff = seal({ tokens, expiresAt: Date.now() + 60000 }, `handoff:${binding}`);
  if (handoff.length > 3800) throw new OAuthError("invalid_token_response", 503);
  cookie(response, HANDOFF_COOKIE, handoff, 60);
  return response;
}

export function completeOAuth(request: NextRequest) {
  validateOrigin(request);
  const binding = request.cookies.get(BINDING_COOKIE)?.value;
  if (!binding) throw new OAuthError("invalid_session");
  const handoff = unseal<{ tokens: Tokens; expiresAt: number }>(request.cookies.get(HANDOFF_COOKIE)?.value, `handoff:${binding}`);
  if (handoff.expiresAt < Date.now()) throw new OAuthError("invalid_session");
  return clearFlow(json(handoff.tokens));
}
