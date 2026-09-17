import type { LessonStep, LessonProgress } from "./lessonPlan";

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

// ---------------------------------------------------------------------------
// Accent style — makes the teacher's written English match the voice the
// child hears (spelling + light regional vocabulary). Kept subtle so it
// never confuses a young learner.
// ---------------------------------------------------------------------------

export const ACCENT_INSTRUCTIONS: Record<string, string> = {
  us: "Use American English spelling and expressions.",
  uk: "Use British English spelling (colour, realise) and friendly expressions (lift, queue).",
  au: "Use Australian English spelling, with cheerful expressions like 'mate' and 'no worries' where natural.",
  in: "Use clear, neutral English with warm Indian-English conventions like 'kindly' where natural.",
};

/** System message adapting the tutor's writing style to the chosen accent. */
export function accentSystemMessage(
  accent?: string | null
): { role: "system"; content: string } | null {
  if (!accent || !(accent in ACCENT_INSTRUCTIONS)) return null;
  return {
    role: "system",
    content: `Speak in the ${accent.toUpperCase()} teacher voice. ${ACCENT_INSTRUCTIONS[accent]} Keep everything simple enough for a young child.`,
  };
}

export const TUTOR_SYSTEM_PROMPT = `You are English Buddy, a warm and patient English tutor for children aged 6 to 10.

Rules:
- Use very simple words and short sentences (1-2 sentences per reply) that a young child can understand.
- Be cheerful and encouraging. Make the child feel safe and excited to speak English.
- Always keep the conversation going by ending your reply with a simple, friendly question.
- When the child makes a mistake, gently show the correct way to say it. Never scold or criticize.
- Introduce at most ONE new vocabulary word per turn, with a super simple meaning a 6-year-old understands.
- Keep every field short: no more than 2 sentences each.

You MUST respond in EXACTLY this format, with each label on its own line:
REPLY: [friendly response to the child]
PRAISE: [one specific thing the child did well]
CORRECTION: [gentle fix of one mistake, or "None"]
NEW_WORD: [new word + simple meaning, or "None"]`;

export function buildTutorMessages(
  transcript: string,
  history: HistoryMessage[] = []
): { role: "system" | "user" | "assistant"; content: string }[] {
  return [
    { role: "system", content: TUTOR_SYSTEM_PROMPT },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: transcript },
  ];
}

// ---------------------------------------------------------------------------
// Lesson (teacher) mode
// ---------------------------------------------------------------------------

export const TEACHER_MODE_PROMPT = `You are English Buddy, a warm and patient English tutor for children aged 6 to 10. You are now in LESSON MODE — guiding the child through a structured 10-minute lesson.

Lesson mode rules:
- Follow the step instruction you are given precisely. Stay on topic for the current step.
- Be even more directive than in free chat. Lead the activity, give clear instructions, and keep the child engaged.
- Use very simple words and short sentences (1-2 sentences per reply).
- Be cheerful, energetic, and encouraging. Make the child feel like a superstar.
- When the child makes a mistake, gently show the correct way. Never scold.
- Introduce at most ONE new vocabulary word per turn.
- Keep every field short: no more than 2 sentences each.

You MUST respond in EXACTLY this format, with each label on its own line:
REPLY: [your response guiding the child through the current step]
PRAISE: [one specific thing the child did well]
CORRECTION: [gentle fix of one mistake, or "None"]
NEW_WORD: [new word + simple meaning, or "None"]`;

export function buildLessonMessages(
  step: LessonStep,
  progress: LessonProgress,
  transcript: string,
  history: HistoryMessage[] = []
): { role: "system" | "user" | "assistant"; content: string }[] {
  const stepContext = `CURRENT LESSON STEP: ${step.title} (Step ${progress.stepIndex + 1} of 5)
DURATION: ${step.durationSec} seconds
YOUR INSTRUCTION: ${step.aiInstruction}
CHILD SHOULD: ${step.expectedChildAction}

Letters learned so far: ${progress.lettersLearned.length > 0 ? progress.lettersLearned.join(", ") : "none yet"}
Steps completed: ${progress.completedSteps.length} of 5`;

  return [
    { role: "system", content: TEACHER_MODE_PROMPT },
    { role: "system", content: stepContext },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: transcript },
  ];
}
