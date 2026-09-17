import {
  deleteAllSessionMeta,
  deleteSessionMeta,
  listSessionMeta,
  upsertSessionMeta,
  type StoredSessionMeta,
} from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isSessionMeta(value: unknown): value is StoredSessionMeta {
  if (value === null || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    (m.type === "chat" || m.type === "lesson") &&
    typeof m.updatedAt === "number"
  );
}

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return Response.json({ error: "Not authenticated" }, { status: 401 });
    }
    return Response.json({ sessions: listSessionMeta(user.id) });
  } catch (error) {
    console.error("🗄️ [sessions] GET failed:", error);
    return Response.json({ error: "Failed to read sessions" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return Response.json({ error: "Not authenticated" }, { status: 401 });
    }
    const body: unknown = await request.json();
    const raw =
      body && typeof body === "object"
        ? (body as { sessions?: unknown }).sessions
        : null;
    if (!Array.isArray(raw)) {
      return Response.json({ error: "sessions array required" }, { status: 400 });
    }
    const sessions = raw.filter(isSessionMeta);
    for (const meta of sessions) upsertSessionMeta(user.id, meta);
    console.log(`🗄️ [sessions] Upserted ${sessions.length} session meta row(s)`);
    return Response.json({ saved: sessions.length });
  } catch (error) {
    console.error("🗄️ [sessions] POST failed:", error);
    return Response.json({ error: "Failed to save sessions" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return Response.json({ error: "Not authenticated" }, { status: 401 });
    }
    const url = new URL(request.url);
    if (url.searchParams.get("all") === "1") {
      const deleted = deleteAllSessionMeta(user.id);
      return Response.json({ deleted });
    }
    const id = url.searchParams.get("id");
    if (!id) {
      return Response.json({ error: "id required" }, { status: 400 });
    }
    const deleted = deleteSessionMeta(user.id, id);
    return Response.json({ deleted });
  } catch (error) {
    console.error("🗄️ [sessions] DELETE failed:", error);
    return Response.json({ error: "Failed to delete session" }, { status: 500 });
  }
}
