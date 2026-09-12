import { transcribeAudio } from "@/lib/asr";
import { getAIResponse } from "@/lib/llm";
import { synthesizeSpeech } from "@/lib/tts";
import type { HistoryMessage } from "@/lib/prompts";

export const runtime = "nodejs";
export const maxDuration = 60;

function parseHistory(raw: FormDataEntryValue | null): HistoryMessage[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is HistoryMessage =>
        m &&
        typeof m.content === "string" &&
        (m.role === "user" || m.role === "assistant")
    );
  } catch {
    return [];
  }
}

export async function POST(request: Request) {
  try {
    console.log("📥 [conversation] Received new conversation request");

    const formData = await request.formData();
    const audio = formData.get("audio");
    const history = parseHistory(formData.get("history"));

    if (!(audio instanceof File)) {
      return Response.json({ error: "Missing audio file" }, { status: 400 });
    }

    // Step 1: Speech → text
    console.log("🎙️ [conversation] Step 1: Transcribing audio…");
    const transcript = await transcribeAudio(audio);
    console.log(`📝 [conversation] Transcript: "${transcript}"`);

    // Step 2: Text → tutor feedback
    console.log("🤖 [conversation] Step 2: Getting AI tutor response…");
    const feedback = await getAIResponse(transcript, history);
    console.log("💬 [conversation] AI reply:", feedback.reply);

    // Step 3: Text → speech
    console.log("🔊 [conversation] Step 3: Synthesizing speech…");
    const audioBuffer = await synthesizeSpeech(feedback.reply);
    const audioBase64 = audioBuffer.toString("base64");
    console.log("✅ [conversation] All steps done, sending response");

    return Response.json({
      transcript,
      aiText: feedback.reply,
      feedback: {
        praise: feedback.praise,
        correction: feedback.correction,
        newWord: feedback.newWord,
      },
      audioBase64,
    });
  } catch (error) {
    console.error("❌ [conversation] Failed:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
