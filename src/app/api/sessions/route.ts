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
    (m.type === "chat" || m.type === "lesson" || m.type === "call") &&
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
    const rawSessions =
      body && typeof body === "object"
        ? (body as { sessions?: unknown }).sessions
        : null;
    // Beacon-fireable deletes for sessions discarded during page unload
    // (sendBeacon can only POST), e.g. an empty voice call.
    const rawDeletions =
      body && typeof body === "object"
        ? (body as { deletions?: unknown }).deletions
        : null;
    const sessions = Array.isArray(rawSessions)
      ? rawSessions.filter(isSessionMeta)
      : [];
    for (const meta of sessions) upsertSessionMeta(user.id, meta);
    let deleted = 0;
    if (Array.isArray(rawDeletions)) {
      for (const id of rawDeletions) {
        if (typeof id === "string") deleted += deleteSessionMeta(user.id, id);
      }
    }
    console.log(
      `🗄️ [sessions] Upserted ${sessions.length}, deleted ${deleted} session meta row(s)`
    );
    return Response.json({ saved: sessions.length, deleted });
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
