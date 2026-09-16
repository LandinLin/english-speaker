import { endSession, getTokenFromCookies } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST() {
  try {
    const token = await getTokenFromCookies();
    await endSession(token);
    return Response.json({ ok: true });
  } catch (error) {
    console.error("❌ [auth/logout] Failed:", error);
    // Still report success — the client clears its side regardless.
    return Response.json({ ok: true });
  }
}
