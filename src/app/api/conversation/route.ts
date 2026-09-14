import { transcribeAudio } from "@/lib/asr";
import { getAIResponse } from "@/lib/llm";
import { synthesizeSpeech } from "@/lib/tts";
import { buildLessonMessages, type HistoryMessage } from "@/lib/prompts";
import { LESSON_STEPS, type LessonProgress } from "@/lib/lessonPlan";

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
    const mode = (formData.get("mode") as string) || "chat";
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
      };
      try {
        if (progressRaw) progress = { ...progress, ...JSON.parse(progressRaw) };
      } catch {
        // use defaults
      }
      const messages = buildLessonMessages(step, progress, transcript, history);
      feedback = await getAIResponse(transcript, history, messages);

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
      feedback = await getAIResponse(transcript, history);
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
