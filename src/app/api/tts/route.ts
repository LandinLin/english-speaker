import { synthesizeSpeech } from "@/lib/tts";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_TEXT_LENGTH = 500;

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    const text =
      body && typeof body === "object" && "text" in body
        ? String((body as { text: unknown }).text ?? "").trim()
        : "";

    if (!text) {
      return Response.json({ error: "Missing text" }, { status: 400 });
    }

    const audioBuffer = await synthesizeSpeech(text.slice(0, MAX_TEXT_LENGTH));
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
