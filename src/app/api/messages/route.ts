import {
  deleteAllMessages,
  deleteMessagesBySession,
  listMessages,
  updateMessageAudio,
  upsertMessages,
  type StoredMessage,
} from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isStoredMessage(value: unknown): value is StoredMessage {
  if (value === null || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    typeof m.sessionId === "string" &&
    typeof m.createdAt === "number" &&
    (m.role === "user" || m.role === "ai") &&
    typeof m.text === "string"
  );
}

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return Response.json({ error: "Not authenticated" }, { status: 401 });
    }
    return Response.json({ messages: await listMessages(user.id) });
  } catch (error) {
    console.error("🗄️ [messages] GET failed:", error);
    return Response.json({ error: "Failed to read messages" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return Response.json({ error: "Not authenticated" }, { status: 401 });
    }
    const body: unknown = await request.json();
    const raw = body && typeof body === "object" ? (body as { messages?: unknown }).messages : null;
    if (!Array.isArray(raw)) {
      return Response.json({ error: "messages array required" }, { status: 400 });
    }
    // Client-sent user identity is ignored — the session is authoritative.
    const messages = raw.filter(isStoredMessage);
    const count = await upsertMessages(user.id, messages);
    return Response.json({ saved: count });
  } catch (error) {
    console.error("🗄️ [messages] POST failed:", error);
    return Response.json({ error: "Failed to save messages" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return Response.json({ error: "Not authenticated" }, { status: 401 });
    }
    const body: unknown = await request.json();
    const { id, audioBase64 } = (body ?? {}) as {
      id?: unknown;
      audioBase64?: unknown;
    };
    if (typeof id !== "string" || typeof audioBase64 !== "string") {
      return Response.json(
        { error: "id and audioBase64 required" },
        { status: 400 }
      );
    }
    const ok = await updateMessageAudio(user.id, id, audioBase64);
    return Response.json({ updated: ok });
  } catch (error) {
    console.error("🗄️ [messages] PATCH failed:", error);
    return Response.json({ error: "Failed to update message" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return Response.json({ error: "Not authenticated" }, { status: 401 });
    }
    const sessionId = new URL(request.url).searchParams.get("sessionId");
    const deleted =
      sessionId === null
        ? await deleteAllMessages(user.id)
        : await deleteMessagesBySession(user.id, sessionId);
    return Response.json({ deleted });
  } catch (error) {
    console.error("🗄️ [messages] DELETE failed:", error);
    return Response.json({ error: "Failed to delete messages" }, { status: 500 });
  }
}
