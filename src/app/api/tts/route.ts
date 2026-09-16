import { synthesizeSpeechEdge } from "@/lib/tts";
import { getCurrentUser } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_TEXT_LENGTH = 500;

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return Response.json({ error: "Not authenticated" }, { status: 401 });
    }

    const body: unknown = await request.json();
    const text =
      body && typeof body === "object" && "text" in body
        ? String((body as { text: unknown }).text ?? "").trim()
        : "";

    if (!text) {
      return Response.json({ error: "Missing text" }, { status: 400 });
    }

    const audioBuffer = await synthesizeSpeechEdge(
      text.slice(0, MAX_TEXT_LENGTH)
    );
    if (!audioBuffer) {
      return Response.json(
        { error: "Speech synthesis unavailable" },
        { status: 502 }
      );
    }
    return Response.json({
      audioBase64: audioBuffer.toString("base64"),
    });
  } catch (error) {
    console.error("❌ [tts] Failed:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
