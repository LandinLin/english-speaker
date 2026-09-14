/**
 * Structured 10-minute lesson plan for English Buddy.
 * Five guided steps: greeting → teach → practice → game → wrap-up.
 */

export interface LessonStep {
  id: string;
  title: string;
  /** Duration allocated to this step, in seconds. */
  durationSec: number;
  /** Instruction injected into the LLM system prompt for this step. */
  aiInstruction: string;
  /** What the child is expected to do — shown in the UI as a hint. */
  expectedChildAction: string;
}

export const LESSON_STEPS: LessonStep[] = [
  {
    id: "greeting",
    title: "Warm-Up Hello",
    durationSec: 60,
    aiInstruction:
      "Welcome the child warmly. Ask their name and how they feel today. Keep it fun and energetic. If they already told you their name in a previous step, use it.",
    expectedChildAction: "Say hello and tell Buddy your name",
  },
  {
    id: "teach",
    title: "Learn: A is for Apple",
    durationSec: 120,
    aiInstruction:
      "Teach the letter 'A' and the word 'Apple'. Say 'A is for Apple!' clearly. Explain that Apple is a red, round fruit. Ask the child to repeat 'Apple' after you. Keep sentences very short.",
    expectedChildAction: "Listen and repeat 'Apple'",
  },
  {
    id: "practice",
    title: "Practice: Say It!",
    durationSec: 180,
    aiInstruction:
      "Practice the word 'Apple' with the child. Ask them to say 'Apple' out loud. Then ask them to name other things that start with the letter A (like Ant, Arm, Alligator). Praise every attempt. Gently correct pronunciation.",
    expectedChildAction: "Say 'Apple' and find A-words",
  },
  {
    id: "game",
    title: "Game: Guessing Time!",
    durationSec: 180,
    aiInstruction:
      "Play a guessing game. Say: 'I'm thinking of something red and round that starts with A. What is it?' Wait for the child to answer. Give hints if they're stuck. Celebrate when they guess 'Apple'. Then do one more round with another A-word (like Ant).",
    expectedChildAction: "Guess the A-word riddle",
  },
  {
    id: "wrapup",
    title: "Great Job!",
    durationSec: 60,
    aiInstruction:
      "Wrap up the lesson. Praise the child for learning the letter A and the word Apple. Ask them to say 'Apple' one last time. Say a warm goodbye and tell them you're proud of them.",
    expectedChildAction: "Say goodbye to Buddy",
  },
];

export const LESSON_TOTAL_DURATION = LESSON_STEPS.reduce(
  (sum, step) => sum + step.durationSec,
  0
); // 600 seconds = 10 minutes

export interface LessonProgress {
  stepIndex: number;
  completedSteps: number[];
  startedAt: number;
  completedAt?: number;
  badgesEarned: string[];
  lettersLearned: string[];
}

const STORAGE_KEY = "english-buddy-lesson-progress";

const DEFAULT_PROGRESS: LessonProgress = {
  stepIndex: 0,
  completedSteps: [],
  startedAt: 0,
  badgesEarned: [],
  lettersLearned: [],
};

export function loadLessonProgress(): LessonProgress {
  if (typeof window === "undefined") return { ...DEFAULT_PROGRESS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PROGRESS };
    const parsed = JSON.parse(raw) as Partial<LessonProgress>;
    return { ...DEFAULT_PROGRESS, ...parsed };
  } catch {
    return { ...DEFAULT_PROGRESS };
  }
}

export function saveLessonProgress(progress: LessonProgress): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // Storage full or unavailable — lesson still works in-memory.
  }
}

export function resetLessonProgress(): LessonProgress {
  const fresh: LessonProgress = {
    ...DEFAULT_PROGRESS,
    startedAt: Date.now(),
  };
  saveLessonProgress(fresh);
  return fresh;
}
