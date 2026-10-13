import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { config, seal, unseal, startOAuth, callbackOAuth, completeOAuth, readToken, googleTokens, safeEqual } from "../src/lib/oauth-server";
import { clearTokens, getAccessToken, loadTokens, storeTokens, AuthError } from "../src/lib/auth-client";
import type { Tokens } from "../src/lib/types";

process.env.GOOGLE_CLIENT_ID = "test-client";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
process.env.GOOGLE_REDIRECT_URI = "http://localhost:3000/api/auth/callback";
const token: Tokens = { accessToken: "old-access", refreshToken: "refresh", expiresAt: 0, accountId: "account", email: "person@example.com", name: "Person" };
const originalFetch = globalThis.fetch;
const values = new Map<string, string>();
const storage = { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
Object.defineProperty(globalThis, "window", { value: { dispatchEvent: () => true }, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
test.afterEach(() => { globalThis.fetch = originalFetch; values.clear(); });

test("configuration rejects untrusted redirect URI and state comparison is exact", () => {
  assert.equal(safeEqual("state", "state"), true);
  assert.equal(safeEqual("state", "different"), false);
  const uri = process.env.GOOGLE_REDIRECT_URI;
  process.env.GOOGLE_REDIRECT_URI = "http://attacker.example/api/auth/callback";
  assert.throws(config, /not_configured/);
  process.env.GOOGLE_REDIRECT_URI = uri;
});

test("encrypted cookie is tamper-resistant and bound to purpose/browser", () => {
  const sealed = seal({ secret: "refresh-token" }, "handoff:browser-a");
  assert.equal(sealed.includes("refresh-token"), false);
  assert.deepEqual(unseal(sealed, "handoff:browser-a"), { secret: "refresh-token" });
  assert.throws(() => unseal(sealed, "handoff:browser-b"), /invalid_session/);
  assert.throws(() => unseal(sealed.slice(0, -4) + "AAAA", "handoff:browser-a"), /invalid_session/);
});

test("OAuth uses offline access, minimal Drive scope, state and PKCE", () => {
  const response = startOAuth();
  const url = new URL(response.headers.get("location")!);
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.match(url.searchParams.get("scope")!, /drive\.file/);
  assert.ok(url.searchParams.get("state"));
  assert.equal(url.searchParams.has("client_secret"), false);
  assert.match(response.headers.get("set-cookie")!, /HttpOnly/);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("callback rejects wrong state before any token exchange", async () => {
  const start = startOAuth();
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error(); };
  const request = new NextRequest("http://localhost:3000/api/auth/callback?state=wrong&code=code", { headers: { cookie: start.cookies.getAll().map(c => `${c.name}=${c.value}`).join("; ") } });
  await assert.rejects(callbackOAuth(request), /invalid_session/);
  assert.equal(called, false);
});

test("successful callback hands tokens off only through bound encrypted cookies", async () => {
  const start = startOAuth();
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  globalThis.fetch = async input => String(input).includes("userinfo") ? Response.json({ sub: "account", email: "person@example.com", name: "Person" }) : Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600, token_type: "Bearer", scope: "https://www.googleapis.com/auth/drive.file" });
  const callback = await callbackOAuth(new NextRequest(`http://localhost:3000/api/auth/callback?state=${state}&code=code`, { headers: { cookie: start.cookies.getAll().map(c => `${c.name}=${c.value}`).join("; ") } }));
  assert.equal(callback.headers.get("location"), "http://localhost:3000/auth/complete");
  assert.equal(callback.headers.get("location")!.includes("access"), false);
  const cookies = new Map(start.cookies.getAll().map(c => [c.name, c.value]));
  for (const c of callback.cookies.getAll()) cookies.set(c.name, c.value);
  const headers = { origin: "http://localhost:3000", cookie: Array.from(cookies).map(([key, value]) => `${key}=${value}`).join("; ") };
  const result = completeOAuth(new NextRequest("http://localhost:3000/api/auth/complete", { method: "POST", headers }));
  assert.equal((await result.json()).accountId, "account");
  assert.equal(result.cookies.get("rainbow_handoff")!.value, "");
  assert.throws(() => completeOAuth(new NextRequest("http://localhost:3000/api/auth/complete", { method: "POST", headers: { ...headers, origin: "https://attacker.example" } })), /invalid_origin/);
});

test("refresh body rejects cross-origin, malformed input, and oversized chunked request", async () => {
  const req = (body: string, origin = "http://localhost:3000") => new Request("http://localhost:3000/api/auth/refresh", { method: "POST", headers: { origin, "content-type": "application/json" }, body });
  await assert.rejects(readToken(req('{"refreshToken":"token"}', "https://attacker.example")), /invalid_origin/);
  await assert.rejects(readToken(req("null")), /invalid_request/);
  await assert.rejects(readToken(req(JSON.stringify({ refreshToken: "x".repeat(13000) }))), /invalid_request/);
  assert.equal(await readToken(req('{"refreshToken":"token"}')), "token");
});

test("Google errors are sanitized and missing refresh tokens stay absent", async () => {
  globalThis.fetch = async () => Response.json({ error: "invalid_grant", error_description: "secret-sensitive-details" }, { status: 400 });
  await assert.rejects(googleTokens({ grant_type: "refresh_token", refresh_token: "refresh" }), /invalid_grant/);
  globalThis.fetch = async () => Response.json({ access_token: "new", expires_in: 3600, token_type: "Bearer" });
  const result = await googleTokens({ grant_type: "refresh_token", refresh_token: "refresh" });
  assert.equal("refreshToken" in result, false);
});

test("parallel browser requests share one refresh and preserve original refresh token", async () => {
  storeTokens(token);
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ accessToken: "new-access", expiresAt: Date.now() + 3600000 }); };
  assert.deepEqual(await Promise.all([getAccessToken(), getAccessToken(), getAccessToken()]), ["new-access", "new-access", "new-access"]);
  assert.equal(calls, 1);
  assert.equal(loadTokens()!.refreshToken, "refresh");
});

test("temporary refresh errors preserve tokens; invalid_grant clears them", async () => {
  storeTokens(token);
  globalThis.fetch = async () => Response.json({ error: "temporarily_unavailable" }, { status: 503 });
  await assert.rejects(getAccessToken(), (error: unknown) => error instanceof AuthError && !error.reconnect);
  assert.ok(loadTokens());
  globalThis.fetch = async () => Response.json({ error: "invalid_grant" }, { status: 401 });
  await assert.rejects(getAccessToken(), (error: unknown) => error instanceof AuthError && error.reconnect);
  assert.equal(loadTokens(), null);
});

test("sign out wins against a refresh that is still in flight", async () => {
  storeTokens(token);
  globalThis.fetch = async () => { clearTokens(); return Response.json({ accessToken: "new", expiresAt: Date.now() + 3600000 }); };
  await assert.rejects(getAccessToken(), /connection changed/);
  assert.equal(loadTokens(), null);
});

test("expired handoff and missing browser binding cannot retrieve tokens", () => {
  const handoff = seal({ tokens: token, expiresAt: Date.now() - 1 }, "handoff:browser");
  const request = (cookies: string) => new NextRequest("http://localhost:3000/api/auth/complete", { method: "POST", headers: { origin: "http://localhost:3000", cookie: cookies } });
  assert.throws(() => completeOAuth(request(`rainbow_binding=browser; rainbow_handoff=${handoff}`)), /invalid_session/);
  assert.throws(() => completeOAuth(request(`rainbow_handoff=${handoff}`)), /invalid_session/);
});

test("declined Drive permission and malformed token responses are rejected", async () => {
  globalThis.fetch = async () => Response.json({ access_token: "access", token_type: "Bearer", expires_in: 3600, scope: "openid email profile" });
  await assert.rejects(googleTokens({ grant_type: "refresh_token" }), /drive_permission_required/);
  globalThis.fetch = async () => Response.json({ access_token: "access", token_type: "Bearer", expires_in: -1 });
  await assert.rejects(googleTokens({ grant_type: "refresh_token" }), /invalid_token_response/);
});
