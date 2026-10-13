import { NextRequest } from "next/server";
import { callbackOAuth, clearFlow, errorResponse, OAuthError, redirect } from "@/lib/oauth-server";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try { return await callbackOAuth(request); }
  catch (error) {
    try { return clearFlow(redirect(`/?authError=${error instanceof OAuthError ? error.code : "temporarily_unavailable"}`)); }
    catch { return errorResponse(error); }
  }
}
