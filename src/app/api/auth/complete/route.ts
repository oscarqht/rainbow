import { NextRequest } from "next/server";
import { clearFlow, completeOAuth, errorResponse } from "@/lib/oauth-server";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try { return completeOAuth(request); }
  catch (error) {
    const response = errorResponse(error);
    try { return clearFlow(response); } catch { return response; }
  }
}
