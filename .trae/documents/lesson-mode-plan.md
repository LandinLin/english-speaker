# Lesson Mode Implementation Plan

## Context

The app currently has a single "free chat" mode: press-and-hold to talk, Buddy replies freely. The user wants a structured **10-minute lesson mode** with 5 guided steps (greeting → teach → practice → game → wrap-up), a progress bar, step navigation, a celebration screen with a badge, and a lesson summary with "Play Again". Lesson progress persists in localStorage.

## Architecture Decision

**Lesson state lives in the frontend, not the API.** The API just needs to know which prompt to use. The frontend tracks `currentStep` and sends `mode=lesson` + `stepIndex` to the API. The API returns the tutor reply + `nextStep` metadata. This keeps the API stateless (consistent with the existing pattern) and avoids server-side session tracking.

## Files to Create

### 1. `src/lib/lessonPlan.ts` (new)
- Export `LessonStep` interface: `{ id, title, durationSec, aiInstruction, expectedChildAction }`
- Export `LESSON_STEPS: LessonStep[]` — 5 steps:
  - `greeting` (60s): "Welcome the child warmly, ask their name or how they feel"
  - `teach` (120s): "Introduce the letter A and the word 'Apple'. Explain simply."
  - `practice` (180s): "Ask the child to say 'Apple'. Ask them to name things that start with A."
  - `game` (180s): "Play a guessing game: 'I'm thinking of something red and round that starts with A…'"
  - `wrapup` (60s): "Praise the child, summarize what they learned, say goodbye"
- Export `LESSON_TOTAL_DURATION` (600 = 10 min)
- Export `LessonProgress` interface: `{ stepIndex: number, completedSteps: number[], startedAt: number, completedAt?: number, badgesEarned: string[], lettersLearned: string[] }`
- Export `loadLessonProgress()` / `saveLessonProgress()` helpers (localStorage key `english-buddy-lesson-progress`)

### 2. `src/components/LessonMode.tsx` (new)
- Props: `{ onExit: () => void }`
- Manages: `stepIndex`, `progress` (from localStorage), `status` (idle/recording/processing), `lessonComplete`
- Renders:
  - **Progress bar**: 5 dots/segments, current highlighted, completed filled
  - **Step header**: step title + "Step 2/5" + elapsed timer
  - **Chat transcript** (reuses `ChatTranscript` component with a lesson-local message list)
  - **🎤 Talk button** (same press-and-hold pattern as page.tsx)
  - **Next ▶ button**: advances step, auto-sends a transition prompt to Buddy
  - **🎉 Celebration screen** on step 5 completion: confetti animation (CSS), badge earned, summary text, "Play Again" + "Exit" buttons
- On step advance: saves progress to localStorage, calls `/api/conversation` with `mode=lesson&stepIndex=N` to get Buddy's transition message
- On completion: marks `completedAt`, awards a "lesson-complete" badge, generates summary from `lettersLearned` + step data

## Files to Modify

### 3. `src/lib/prompts.ts`
- Add `TEACHER_MODE_PROMPT` — structured system prompt that instructs the LLM to follow the lesson flow, stay on the current step's topic, be more directive than free chat, and still use the same REPLY/PRAISE/CORRECTION/NEW_WORD format (so `parseTutorResponse` works unchanged)
- Add `buildLessonMessages(step: LessonStep, childName: string, progress: LessonProgress, transcript: string, history: HistoryMessage[])` — returns the messages array with:
  - System: `TEACHER_MODE_PROMPT`
  - System: step-specific instruction (`step.aiInstruction`)
  - History messages
  - User: transcript

### 4. `src/lib/llm.ts`
- Add optional `messages` parameter to `getAIResponse` so lesson mode can pass custom-built messages instead of always using `buildTutorMessages`. Signature: `getAIResponse(transcript, history?, messages?)`. If `messages` is provided, use it directly; otherwise build from `buildTutorMessages`.

### 5. `src/app/api/conversation/route.ts`
- Accept `mode` ("chat" | "lesson") and `stepIndex` from FormData
- If `mode === "lesson"`: import `LESSON_STEPS`, build lesson messages via `buildLessonMessages`, pass to `getAIResponse`
- Response gains: `mode`, `stepIndex`, `nextStepIndex` (current + 1, or null if last step), `stepTitle`, `nextStepTitle`

### 6. `src/app/page.tsx`
- Add `mode` state: `"chat" | "lesson"`
- Add toggle UI in header (two pill buttons: "💬 Free Chat" / "📚 10-Min Lesson")
- When `mode === "lesson"`: render `<LessonMode onExit={() => setMode("chat")} />` instead of the free-chat record button + transcript
- When `mode === "chat"`: existing UI unchanged

### 7. `src/lib/badges.ts`
- Add one badge: `{ id: "lesson-1", emoji: "🎓", name: "Lesson Star", description: "Finish your first 10-minute lesson", ... }` — but since badges are computed from sessions, we'll track lesson completion via the lesson progress localStorage and display the celebration badge directly in the LessonMode component (not through the badge system, which is session-based). This avoids coupling two different storage systems.

## Key Patterns to Reuse

- **Recording**: copy the `startRecording`/`stopRecording`/press-and-hold pattern from `page.tsx` into `LessonMode.tsx` (self-contained)
- **API call**: same `/api/conversation` endpoint, just add `mode` and `stepIndex` to FormData
- **ChatTranscript**: reuse directly with lesson-local messages
- **TTS playback**: reuse `playClip`/`stopPlayback` from `audioPlayer.ts`
- **Response format**: same `ConversationResponse` shape, just extended with lesson metadata

## What NOT to Do

- No server-side lesson state — fully client-driven
- No changes to messageStore — lesson messages live in component state, not the persistent chat history (keeps lessons separate from free chat sessions)
- No changes to SQLite schema
- No changes to PWA/offline queue for lessons (lessons require connectivity)

## Verification

1. `npx tsc --noEmit && npm run lint && npm run build` — all must pass
2. Browser test: open app → toggle to "10-Min Lesson" → verify progress bar shows → press-and-hold to talk → Buddy responds in teacher mode → click "Next" → step advances → progress bar updates → repeat through step 5 → celebration screen appears with badge + summary → "Play Again" resets to step 1
3. Refresh page mid-lesson → verify progress restored from localStorage
4. Toggle back to "Free Chat" → verify existing chat still works unchanged
