import { errorResponse, googleTokens, json, readToken } from "@/lib/oauth-server";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try { return json(await googleTokens({ grant_type: "refresh_token", refresh_token: await readToken(request) })); }
  catch (error) { return errorResponse(error); }
}
