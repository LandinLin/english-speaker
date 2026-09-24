import { transcribeAudio } from "@/lib/asr";
import { getAIResponse } from "@/lib/llm";
import { synthesizeSpeechEdge } from "@/lib/tts";
import { buildLessonMessages, type HistoryMessage } from "@/lib/prompts";
import { LESSON_STEPS, type LessonProgress } from "@/lib/lessonPlan";
import { getCurrentUser } from "@/lib/auth";

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

    const user = await getCurrentUser();
    if (!user) {
      return Response.json({ error: "Not authenticated" }, { status: 401 });
    }

    const formData = await request.formData();
    const audio = formData.get("audio");
    const history = parseHistory(formData.get("history"));
    const mode = (formData.get("mode") as string) || "chat";
    const accentRaw = formData.get("accent");
    const accent = typeof accentRaw === "string" ? accentRaw : null;
    const voiceRaw = formData.get("voice");
    const voiceType = typeof voiceRaw === "string" ? voiceRaw : null;
    const stepIndexRaw = formData.get("stepIndex") as string;
    const stepIndex = stepIndexRaw ? parseInt(stepIndexRaw, 10) : 0;
    const progressRaw = formData.get("progress") as string;

    if (!(audio instanceof File)) {
      return Response.json({ error: "Missing audio file" }, { status: 400 });
    }

    // Step 1: Speech → text
    console.log("🎙️ [conversation] Step 1: Transcribing audio…");
    const transcript = await transcribeAudio(audio);
    console.log(`📝 [conversation] Transcript: "${transcript}"`);

    // Step 2: Text → tutor feedback
    console.log("🤖 [conversation] Step 2: Getting AI tutor response…");
    let feedback;
    let lessonMeta:
      | { mode: "lesson"; stepIndex: number; stepTitle: string; nextStepIndex: number | null; nextStepTitle: string | null }
      | { mode: "chat" }
      = { mode: "chat" };

    if (mode === "lesson" && stepIndex >= 0 && stepIndex < LESSON_STEPS.length) {
      const step = LESSON_STEPS[stepIndex];
      let progress: LessonProgress = {
        stepIndex,
        completedSteps: [],
        startedAt: 0,
        badgesEarned: [],
        lettersLearned: [],
        elapsedSec: 0,
        stepTurns: [],
      };
      try {
        if (progressRaw) progress = { ...progress, ...JSON.parse(progressRaw) };
      } catch {
        // use defaults
      }
      const messages = buildLessonMessages(step, progress, transcript, history);
      feedback = await getAIResponse(transcript, history, messages, accent);

      const nextStepIndex =
        stepIndex + 1 < LESSON_STEPS.length ? stepIndex + 1 : null;
      lessonMeta = {
        mode: "lesson",
        stepIndex,
        stepTitle: step.title,
        nextStepIndex,
        nextStepTitle: nextStepIndex !== null ? LESSON_STEPS[nextStepIndex].title : null,
      };
      console.log(`📚 [conversation] Lesson mode: step ${stepIndex + 1}/${LESSON_STEPS.length} (${step.id})`);
    } else {
      feedback = await getAIResponse(transcript, history, undefined, accent);
    }
    console.log("💬 [conversation] AI reply:", feedback.reply);

      // In lesson mode, determine if the child's answer was "correct"
      // (no correction needed = correct)
      let correct: boolean | undefined;
      if (mode === "lesson") {
        correct =
          !feedback.correction ||
          feedback.correction.trim().toLowerCase() === "none";
      }

      // Step 3: Text → speech (Edge TTS, free). Failure is non-fatal: the
    // response still succeeds with text/feedback but no audio.
    console.log("🔊 [conversation] Step 3: Synthesizing speech (Edge TTS)…");
    const audioBuffer = await synthesizeSpeechEdge(
      feedback.reply,
      accent,
      voiceType
    );
    const audioBase64 = audioBuffer ? audioBuffer.toString("base64") : null;
    console.log(
      audioBase64
        ? "✅ [conversation] All steps done, sending response"
        : "⚠️ [conversation] No audio (Edge TTS failed), sending text-only response"
    );

    return Response.json({
      transcript,
      aiText: feedback.reply,
      feedback: {
        praise: feedback.praise,
        correction: feedback.correction,
        newWord: feedback.newWord,
      },
      audioBase64,
      correct,
      ...lessonMeta,
    });
  } catch (error) {
    console.error("❌ [conversation] Failed:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
