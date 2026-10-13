import { errorResponse, startOAuth } from "@/lib/oauth-server";
export const runtime = "nodejs";
export async function GET() { try { return startOAuth(); } catch (error) { return errorResponse(error); } }
