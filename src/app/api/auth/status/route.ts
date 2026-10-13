import { isConfigured, json } from "@/lib/oauth-server";
export const runtime = "nodejs";
export async function GET() { return json({ configured: isConfigured() }); }
