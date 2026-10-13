import { errorResponse, json, OAuthError, readToken } from "@/lib/oauth-server";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const token = await readToken(request);
    const response = await fetch("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }), cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (data.error !== "invalid_token") throw new OAuthError("temporarily_unavailable", 503);
    }
    return json({ disconnected: true });
  } catch (error) { return errorResponse(error); }
}
