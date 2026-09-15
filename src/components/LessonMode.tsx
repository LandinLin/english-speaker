"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ChatTranscript from "@/components/ChatTranscript";
import BadgeUnlock from "@/components/BadgeUnlock";
import LessonComplete from "@/components/LessonComplete";
import MicroCelebration, { type MicroType } from "@/components/MicroCelebration";
import { playClip, stopPlayback } from "@/lib/audioPlayer";
import {
  LESSON_STEPS,
  LESSON_TOTAL_DURATION,
  TEACHER_AVATAR_URL,
  loadLessonProgress,
  resetLessonProgress,
  saveLessonProgress,
  type LessonProgress,
} from "@/lib/lessonPlan";
import type { ChatMessage } from "@/lib/messageStore";
import {
  checkNewBadges,
  type Badge,
  type LearningStats,
} from "@/lib/badges";
import {
  addEarnedBadge,
  getEarnedBadges,
  getStats,
  saveStats,
} from "@/lib/badgeStorage";

interface LessonConversationResponse {
  transcript?: string;
  aiText?: string;
  feedback?: { praise?: string; correction?: string; newWord?: string };
  audioBase64?: string;
  error?: string;
  mode?: string;
  stepIndex?: number;
  stepTitle?: string;
  nextStepIndex?: number | null;
  nextStepTitle?: string | null;
  correct?: boolean;
}

type Status = "idle" | "recording" | "processing";

const TOUCH_MOUSE_GRACE_MS = 800;
const LESSON_MESSAGES_KEY = "english-buddy-lesson-messages";

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Round teacher picture: emoji base, generated photo layered on when ready. */
function TeacherAvatar({
  size,
  ready,
  ring,
}: {
  size: number;
  ready: boolean;
  ring?: boolean;
}) {
  return (
    <div
      className={`relative shrink-0 overflow-hidden rounded-full bg-gradient-to-br from-orange-200 via-amber-100 to-pink-200 ${
        ring ? "border-2 border-white shadow-md" : "border border-white shadow"
      }`}
      style={{ width: size, height: size }}
    >
      <div
        className="flex h-full w-full items-center justify-center"
        style={{ fontSize: size * 0.55 }}
      >
        👩‍🏫
      </div>
      {ready && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={TEACHER_AVATAR_URL}
          alt="Teacher Buddy"
          crossOrigin="anonymous"
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
    </div>
  );
}

function loadLessonMessages(): ChatMessage[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(LESSON_MESSAGES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLessonMessages(messages: ChatMessage[]): void {
  if (typeof window === "undefined") return;
  try {
    // Strip audioBase64 to save space — it can be re-synthesized via TTS.
    const slim = messages.map((m) => ({ ...m, audioBase64: undefined }));
    localStorage.setItem(LESSON_MESSAGES_KEY, JSON.stringify(slim));
  } catch {
    // ignore
  }
}

export default function LessonMode({ onExit }: { onExit: () => void }) {
  const [progress, setProgress] = useState<LessonProgress>(() => {
    const loaded = loadLessonProgress();
    return loaded.startedAt === 0
      ? { ...loaded, startedAt: Date.now() }
      : loaded;
  });
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    loadLessonMessages()
  );
  const [status, setStatus] = useState<Status>("idle");
  const [lessonComplete, setLessonComplete] = useState<boolean>(
    () => loadLessonProgress().completedAt !== undefined
  );
  const [error, setError] = useState<string | null>(null);
  const [badgeQueue, setBadgeQueue] = useState<Badge[]>([]);
  const [lessonNewBadges, setLessonNewBadges] = useState<Badge[]>([]);
  const [microTrigger, setMicroTrigger] = useState(0);
  const [microType, setMicroType] = useState<MicroType>("correct");
  const [avatarReady, setAvatarReady] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const lastTouchAtRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const historyRef = useRef<{ role: "user" | "assistant"; content: string }[]>(
    []
  );
  const stepIndexRef = useRef(progress.stepIndex);

  const stepIndex = progress.stepIndex;
  const currentStep = LESSON_STEPS[stepIndex] ?? LESSON_STEPS[0];
  const isLastStep = stepIndex === LESSON_STEPS.length - 1;

  // ── 10-minute countdown ──────────────────────────────────────────────
  // Derived — no separate "time up" state needed.
  const timedOut =
    !lessonComplete && progress.elapsedSec >= LESSON_TOTAL_DURATION;
  const remainingSec = Math.max(
    0,
    LESSON_TOTAL_DURATION - progress.elapsedSec
  );
  const stepDone = (progress.stepTurns[stepIndex] ?? 0) >= 1;
  // Keep latest timedOut flag reachable from async recording callbacks.
  const timedOutRef = useRef(timedOut);
  useEffect(() => {
    timedOutRef.current = timedOut;
  }, [timedOut]);

  // Single authoritative ticker — paused on finish, time-up, or badge overlay.
  const timerPaused = lessonComplete || timedOut || badgeQueue.length > 0;
  useEffect(() => {
    if (timerPaused) return;
    const id = setInterval(() => {
      setProgress((prev) => {
        if (prev.completedAt || prev.elapsedSec >= LESSON_TOTAL_DURATION) {
          return prev;
        }
        return {
          ...prev,
          elapsedSec: Math.min(prev.elapsedSec + 1, LESSON_TOTAL_DURATION),
        };
      });
    }, 1000);
    return () => clearInterval(id);
  }, [timerPaused]);

  // ── Teacher avatar ───────────────────────────────────────────────────
  // The image endpoint serves a "generating…" placeholder until the real
  // picture is ready. Probe it, inspect pixels (placeholder is mostly light
  // gray), and only swap in the generated image when it's the real thing.
  // The emoji avatar stays visible meanwhile — never a broken/placeholder UI.
  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const probe = () => {
      attempts += 1;
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        let isPlaceholder = true;
        try {
          const canvas = document.createElement("canvas");
          canvas.width = 32;
          canvas.height = 32;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.drawImage(img, 0, 0, 32, 32);
            const { data } = ctx.getImageData(0, 0, 32, 32);
            let lightGray = 0;
            for (let i = 0; i < data.length; i += 4) {
              const r = data[i];
              const g = data[i + 1];
              const b = data[i + 2];
              if (
                r > 180 &&
                g > 180 &&
                b > 180 &&
                Math.max(r, g, b) - Math.min(r, g, b) < 12
              ) {
                lightGray += 1;
              }
            }
            isPlaceholder = lightGray / (data.length / 4) > 0.6;
          }
        } catch {
          // Tainted canvas — can't verify, keep emoji.
          isPlaceholder = true;
        }
        if (!isPlaceholder && !cancelled) {
          setAvatarReady(true);
        } else if (attempts < 4 && !cancelled) {
          timers.push(setTimeout(probe, 8000));
        }
      };
      img.src = TEACHER_AVATAR_URL;
    };

    probe();
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, []);

  // Keep refs in sync
  useEffect(() => {
    stepIndexRef.current = stepIndex;
  }, [stepIndex]);

  useEffect(() => {
    historyRef.current = messages.slice(-4).map((m) => ({
      role: m.role === "user" ? ("user" as const) : ("assistant" as const),
      content: m.text,
    }));
  }, [messages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, status]);

  // Persist messages + progress
  useEffect(() => {
    saveLessonMessages(messages);
  }, [messages]);

  useEffect(() => {
    saveLessonProgress(progress);
  }, [progress]);

  const addMessage = useCallback(
    (role: "user" | "ai", text: string, extra?: Partial<ChatMessage>) => {
      const msg: ChatMessage = {
        id: uid(),
        sessionId: "lesson",
        createdAt: Date.now(),
        role,
        text,
        ...extra,
      };
      setMessages((prev) => [...prev, msg]);
      return msg;
    },
    []
  );

  const submitRecording = useCallback(async () => {
    // Lesson already ended (time-up or finished) — discard the recording.
    if (timedOutRef.current) {
      chunksRef.current = [];
      mediaRecorderRef.current = null;
      setStatus("idle");
      return;
    }

    const blob = new Blob(chunksRef.current, {
      type: chunksRef.current[0]?.type || "audio/webm",
    });
    chunksRef.current = [];
    mediaRecorderRef.current = null;

    if (blob.size === 0) {
      setStatus("idle");
      return;
    }

    setStatus("processing");
    setError(null);

    const formData = new FormData();
    formData.append("audio", new File([blob], "speech.webm", { type: blob.type }));
    formData.append("history", JSON.stringify(historyRef.current));
    formData.append("mode", "lesson");
    formData.append("stepIndex", String(stepIndexRef.current));
    formData.append("progress", JSON.stringify(progress));

    try {
      const res = await fetch("/api/conversation", {
        method: "POST",
        body: formData,
      });
      const data: LessonConversationResponse = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || `Request failed (${res.status})`);
      }

      // Time may have run out while Buddy was thinking — drop late reply.
      if (timedOutRef.current) {
        setStatus("idle");
        return;
      }

      addMessage("user", data.transcript ?? "");
      const aiMsg = addMessage("ai", data.aiText ?? "", {
        praise: data.feedback?.praise,
        correction: data.feedback?.correction,
        newWord: data.feedback?.newWord,
        audioBase64: data.audioBase64,
      });
      if (aiMsg.audioBase64) {
        playClip(aiMsg.id, `data:audio/mpeg;base64,${aiMsg.audioBase64}`);
      }

      // Micro-celebration on correct answers
      if (data.correct) {
        setMicroType(Math.random() > 0.5 ? "great" : "correct");
        setMicroTrigger((t) => t + 1);
      }

      // Count this speaking turn for the current step (unlocks Next) and
      // track letters learned.
      const learnedNewWord =
        !!data.feedback?.newWord && data.feedback.newWord !== "None";
      setProgress((prev) => {
        const turns = [...prev.stepTurns];
        turns[stepIndexRef.current] =
          (turns[stepIndexRef.current] ?? 0) + 1;
        return {
          ...prev,
          stepTurns: turns,
          lettersLearned:
            learnedNewWord && !prev.lettersLearned.includes("A")
              ? [...prev.lettersLearned, "A"]
              : prev.lettersLearned,
        };
      });

      // Update global stats in localStorage
      const currentStats = getStats();
      const updatedStats: LearningStats = {
        ...currentStats,
        totalSentences: currentStats.totalSentences + 1,
        uniqueWordsLearned:
          data.feedback?.newWord && data.feedback.newWord !== "None"
            ? currentStats.uniqueWordsLearned + 1
            : currentStats.uniqueWordsLearned,
        lettersLearned: data.feedback?.newWord
          ? [...new Set([...currentStats.lettersLearned, "A"])]
          : currentStats.lettersLearned,
      };
      saveStats(updatedStats);

      // Check for new badges
      const newBadges = checkNewBadges(updatedStats, getEarnedBadges());
      if (newBadges.length > 0) {
        for (const badge of newBadges) {
          addEarnedBadge(badge.id);
        }
        setBadgeQueue((prev) => [...prev, ...newBadges]);
      }
    } catch (err) {
      console.error("📚 [lesson] Conversation failed:", err);
      setError(err instanceof Error ? err.message : "Something went wrong. Try again!");
    } finally {
      setStatus("idle");
    }
  }, [addMessage, progress]);

  const startRecording = useCallback(async () => {
    if (status !== "idle") return;
    stopPlayback();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      const mimeType = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : undefined;
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined
      );
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => void submitRecording();
      recorder.start();
      mediaRecorderRef.current = recorder;
      setStatus("recording");
    } catch (err) {
      console.error("🎤 [lesson] Microphone access failed:", err);
      setError("Please allow microphone access so Buddy can hear you.");
      setStatus("idle");
    }
  }, [status, submitRecording]);

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    setStatus("processing");
    recorder.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  // Release outside the button should also stop recording.
  useEffect(() => {
    if (status !== "recording") return;
    const handleUp = () => stopRecording();
    window.addEventListener("mouseup", handleUp);
    window.addEventListener("touchend", handleUp);
    return () => {
      window.removeEventListener("mouseup", handleUp);
      window.removeEventListener("touchend", handleUp);
    };
  }, [status, stopRecording]);

  // Time's up: release the mic immediately so the late reply is dropped.
  useEffect(() => {
    if (!timedOut) return;
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // already stopping
      }
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, [timedOut]);

  const handleStartMouse = (e: React.MouseEvent) => {
    e.preventDefault();
    if (Date.now() - lastTouchAtRef.current < TOUCH_MOUSE_GRACE_MS) return;
    void startRecording();
  };

  const handleStartTouch = () => {
    lastTouchAtRef.current = Date.now();
    void startRecording();
  };

  const handleStopMouse = () => {
    if (Date.now() - lastTouchAtRef.current < TOUCH_MOUSE_GRACE_MS) return;
    stopRecording();
  };

  const handleStopTouch = () => {
    lastTouchAtRef.current = Date.now();
    stopRecording();
  };

  const handleNextStep = useCallback(() => {
    // Must finish the current section (at least one speaking turn) first.
    if (!stepDone || timedOut) return;

    if (isLastStep) {
      // Complete the lesson — update stats and check for badges
      const currentStats = getStats();
      const hasCorrections = messages.some(
        (m) => m.role === "ai" && m.correction && m.correction !== "None"
      );
      const earnedMinutes = Math.max(1, Math.round(progress.elapsedSec / 60));
      const updatedStats: LearningStats = {
        ...currentStats,
        totalLessons: currentStats.totalLessons + 1,
        perfectLessons: hasCorrections
          ? currentStats.perfectLessons
          : currentStats.perfectLessons + 1,
        totalMinutes: currentStats.totalMinutes + earnedMinutes,
      };
      saveStats(updatedStats);

      const newBadges = checkNewBadges(updatedStats, getEarnedBadges());
      for (const badge of newBadges) {
        addEarnedBadge(badge.id);
      }
      setLessonNewBadges(newBadges);
      if (newBadges.length > 0) {
        setBadgeQueue((prev) => [...prev, ...newBadges]);
      }

      setProgress((prev) => ({
        ...prev,
        completedSteps: [...prev.completedSteps, stepIndexRef.current],
        completedAt: Date.now(),
        badgesEarned: [
          ...prev.badgesEarned,
          ...newBadges.map((b) => b.id),
        ],
      }));
      setLessonComplete(true);
      return;
    }

    setProgress((prev) => ({
      ...prev,
      stepIndex: stepIndexRef.current + 1,
      completedSteps: [...prev.completedSteps, stepIndexRef.current],
    }));
  }, [isLastStep, messages, stepDone, timedOut, progress.elapsedSec]);

  const handlePlayAgain = useCallback(() => {
    stopPlayback();
    const fresh = resetLessonProgress();
    setProgress(fresh);
    setMessages([]);
    setLessonComplete(false);
    setError(null);
    saveLessonMessages([]);
  }, []);

  const handleExit = useCallback(() => {
    stopPlayback();
    onExit();
  }, [onExit]);

  // ── Celebration screen ────────────────────────────────────────────────
  const currentStats = getStats();
  if (lessonComplete && badgeQueue.length === 0) {
    return (
      <>
        <LessonComplete
          stats={currentStats}
          newBadges={lessonNewBadges}
          onPlayAgain={handlePlayAgain}
          onExit={handleExit}
        />
        <MicroCelebration trigger={microTrigger} type={microType} />
      </>
    );
  }

  // ── Badge unlock overlay ─────────────────────────────────────────────
  if (badgeQueue.length > 0) {
    return (
      <>
        <div className="flex h-full items-center justify-center bg-gradient-to-b from-blue-50 to-purple-50">
          <p className="text-lg font-bold text-gray-400">Loading celebration…</p>
        </div>
        <BadgeUnlock
          badge={badgeQueue[0]}
          onDismiss={() => setBadgeQueue((prev) => prev.slice(1))}
        />
        <MicroCelebration trigger={microTrigger} type={microType} />
      </>
    );
  }

  // ── Time's up screen (no completion badge) ───────────────────────────
  if (timedOut) {
    return (
      <div className="relative flex h-full flex-col items-center justify-center overflow-hidden bg-gradient-to-b from-orange-100 via-amber-50 to-yellow-100 px-6 text-center">
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          {["⏰", "⏳", "⭐", "✨"].map((emoji, i) => (
            <span
              key={i}
              className="absolute text-3xl"
              style={{
                left: `${15 + i * 25}%`,
                top: `${12 + (i % 2) * 8}%`,
                animation: `float ${2.5 + i * 0.4}s ease-in-out ${i * 0.2}s infinite alternate`,
              }}
            >
              {emoji}
            </span>
          ))}
        </div>
        <style>{`
          @keyframes float {
            from { transform: translateY(0) rotate(-8deg); }
            to { transform: translateY(-14px) rotate(8deg); }
          }
        `}</style>

        <div className="relative z-10 flex flex-col items-center gap-4">
          <div className="animate-bounce text-7xl">⏰</div>
          <h1 className="text-3xl font-extrabold text-orange-500">
            Time&apos;s Up!
          </h1>
          <div className="max-w-sm rounded-2xl bg-white/90 px-6 py-4 shadow-lg">
            <p className="text-sm font-medium text-gray-700">
              You practiced for 10 minutes — great effort! 🌟
            </p>
            <p className="mt-1 text-sm font-bold text-orange-500">
              Let&apos;s try again and finish all 5 steps! 💪
            </p>
          </div>
          <div className="flex flex-col gap-2 pt-2 sm:flex-row sm:justify-center">
            <button
              type="button"
              onClick={handlePlayAgain}
              className="rounded-full bg-orange-400 px-8 py-3.5 text-sm font-bold text-white shadow-lg transition-colors hover:bg-orange-500"
              style={{ minHeight: 60 }}
            >
              🔁 Try Again
            </button>
            <button
              type="button"
              onClick={handleExit}
              className="rounded-full bg-gray-300 px-8 py-3.5 text-sm font-bold text-gray-700 shadow-lg transition-colors hover:bg-gray-400"
              style={{ minHeight: 60 }}
            >
              🏠 Exit
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Lesson UI ──────────────────────────────────────────────────────────
  return (
    <div className="flex h-full flex-col">
      <MicroCelebration trigger={microTrigger} type={microType} />
      {/* Progress bar */}
      <div className="border-b border-gray-200 bg-white/80 px-4 py-3 backdrop-blur">
        <div className="mx-auto max-w-xl">
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={handleExit}
              className="rounded-full px-2 py-1 text-xs font-medium text-gray-500 hover:bg-gray-100"
            >
              ← Exit
            </button>
            <span
              className={`rounded-full px-3 py-1 text-sm font-extrabold tabular-nums shadow-sm transition-colors ${
                remainingSec <= 60
                  ? "animate-pulse bg-red-100 text-red-600"
                  : "bg-blue-100 text-blue-700"
              }`}
            >
              ⏱ {formatTime(remainingSec)}
            </span>
            <span className="text-sm font-bold text-gray-700">
              Step {stepIndex + 1} / {LESSON_STEPS.length}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            {LESSON_STEPS.map((step, i) => (
              <div key={step.id} className="flex flex-1 flex-col items-center gap-1">
                <div
                  className={`h-2 w-full rounded-full transition-colors ${
                    i < stepIndex || (progress.stepTurns[i] ?? 0) > 0
                      ? "bg-green-400"
                      : i === stepIndex
                        ? "bg-blue-500"
                        : "bg-gray-200"
                  }`}
                />
                <span
                  className={`text-[9px] font-medium ${
                    i === stepIndex ? "text-blue-600" : "text-gray-400"
                  }`}
                >
                  {step.title.split(":")[0]}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Step header with teacher avatar */}
      <div className="bg-blue-50 px-4 py-2">
        <div className="mx-auto flex max-w-xl items-center gap-3">
          <div className="relative shrink-0">
            <TeacherAvatar size={48} ready={avatarReady} ring />
            <span className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-green-400 text-[8px]">
              ✓
            </span>
          </div>
          <div className="min-w-0">
            <p className="text-sm font-bold leading-tight text-blue-700">
              {currentStep.title}
            </p>
            <p className="truncate text-xs text-blue-500">
              👩‍🏫 Ms. Buddy · {currentStep.expectedChildAction}
            </p>
          </div>
        </div>
      </div>

      {/* Chat area */}
      <div className="flex-1 overflow-y-auto px-4 pb-32">
        <div className="mx-auto flex max-w-xl flex-col gap-3">
          {messages.length === 0 && status === "idle" && (
            <div className="flex items-end gap-2">
              <TeacherAvatar size={36} ready={avatarReady} />
              <div className="max-w-[80%] rounded-2xl rounded-bl-sm bg-white px-4 py-2 text-gray-800 shadow">
                Hi! I&apos;m Ms. Buddy, your English teacher! Press and hold the
                button below, then say &quot;Hello!&quot; 👋
              </div>
            </div>
          )}

          <ChatTranscript messages={messages} />

          {status === "processing" && (
            <div className="flex flex-col items-start gap-1">
              <div className="max-w-[80%] rounded-2xl rounded-bl-sm bg-white px-4 py-2 text-gray-400 shadow">
                Thinking…
              </div>
            </div>
          )}

          {error && (
            <div className="mx-auto max-w-md rounded-xl bg-red-50 px-3 py-2 text-center text-xs font-medium text-red-600">
              ⚠️ {error}
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* Bottom controls: Talk + Next */}
      <div className="fixed bottom-0 left-0 right-0 z-10 flex flex-col items-center gap-1 bg-gradient-to-t from-blue-50 to-transparent px-4 pb-6 pt-2">
        {!stepDone && (
          <span className="rounded-full bg-amber-100 px-3 py-1 text-[11px] font-bold text-amber-700 shadow-sm">
            🔒 Talk to Ms. Buddy to unlock {isLastStep ? "Finish" : "Next"}!
          </span>
        )}
        <div className="flex items-end justify-center gap-3">
          <button
            type="button"
            aria-label="Press and hold to speak"
            disabled={status === "processing"}
            onMouseDown={handleStartMouse}
            onMouseUp={handleStopMouse}
            onTouchStart={handleStartTouch}
            onTouchEnd={handleStopTouch}
            onContextMenu={(e) => e.preventDefault()}
            className={`flex h-20 w-20 touch-none select-none items-center justify-center rounded-full text-3xl shadow-xl transition-all duration-200 ${
              status === "recording"
                ? "scale-125 bg-red-500 text-white"
                : status === "processing"
                  ? "bg-gray-400 text-white"
                  : "bg-blue-500 text-white hover:bg-blue-600"
            }`}
          >
            {status === "processing" ? "⏳" : "🎤"}
          </button>

          <button
            type="button"
            onClick={handleNextStep}
            disabled={status !== "idle" || !stepDone}
            className="mb-1 rounded-full bg-green-500 px-5 py-3 text-sm font-bold text-white shadow-lg transition-all hover:bg-green-600 disabled:cursor-not-allowed disabled:bg-gray-400 disabled:opacity-60"
            style={{ minHeight: 56 }}
          >
            {isLastStep ? "🎉 Finish" : "Next ▶"}
          </button>
        </div>
      </div>
    </div>
  );
}
