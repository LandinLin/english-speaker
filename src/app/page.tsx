"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ChatTranscript from "@/components/ChatTranscript";
import InstallPrompt from "@/components/InstallPrompt";
import {
  addExchange,
  appendNotice,
  beginNewSession,
  clearAllMessages,
  useMessages,
  usePendingNewSession,
} from "@/lib/messageStore";
import { playClip, stopPlayback } from "@/lib/audioPlayer";
import { enqueueExchange } from "@/lib/offlineQueue";
import { computeStats } from "@/lib/stats";
import { countEarnedBadges } from "@/lib/badges";

interface ConversationResponse {
  transcript?: string;
  aiText?: string;
  feedback?: {
    praise?: string;
    correction?: string;
    newWord?: string;
  };
  audioBase64?: string;
  error?: string;
}

type Status = "idle" | "recording" | "processing";

const HISTORY_LIMIT = 4;
// Ignore synthetic mouse events fired right after touch events on mobile.
const TOUCH_MOUSE_GRACE_MS = 800;

// The D-ID SDK is heavy and browser-only — load the overlay (and its SDK)
// only when the child actually opens the video call.
const DigitalHumanCall = dynamic(
  () => import("@/components/DigitalHumanCall"),
  { ssr: false }
);

export default function Home() {
  const allMessages = useMessages();
  const pendingNew = usePendingNewSession();
  const [status, setStatus] = useState<Status>("idle");
  const [showVideoCall, setShowVideoCall] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const lastTouchAtRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Home shows the latest session; "New chat" shows an empty conversation
  // until the child speaks again.
  const activeSessionId = pendingNew
    ? null
    : (allMessages[allMessages.length - 1]?.sessionId ?? null);
  const visibleMessages = useMemo(
    () =>
      activeSessionId
        ? allMessages.filter((m) => m.sessionId === activeSessionId)
        : [],
    [allMessages, activeSessionId]
  );

  // Keep the latest few messages available for the API history parameter.
  const historyRef = useRef<{ role: "user" | "assistant"; content: string }[]>(
    []
  );

  const stats = useMemo(() => computeStats(allMessages), [allMessages]);
  const earnedBadgeCount = useMemo(
    () => countEarnedBadges(stats.sessions),
    [stats.sessions]
  );
  useEffect(() => {
    historyRef.current = allMessages.slice(-HISTORY_LIMIT).map((m) => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.text,
    }));
  }, [allMessages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [visibleMessages, status]);

  // Shared by live responses and responses drained from the offline outbox.
  const applyExchange = useCallback((data: ConversationResponse) => {
    const { ai } = addExchange({
      transcript: data.transcript ?? "",
      aiText: data.aiText ?? "",
      praise: data.feedback?.praise,
      correction: data.feedback?.correction,
      newWord: data.feedback?.newWord,
      audioBase64: data.audioBase64,
    });
    if (ai.audioBase64) {
      playClip(ai.id, `data:audio/mpeg;base64,${ai.audioBase64}`);
    }
  }, []);

  // Offline queue was drained by OfflineQueueDrain after reconnecting.
  useEffect(() => {
    const handler = (event: Event) => {
      const data = (event as CustomEvent<ConversationResponse>).detail;
      if (data) applyExchange(data);
    };
    window.addEventListener("english-buddy:exchange", handler);
    return () =>
      window.removeEventListener("english-buddy:exchange", handler);
  }, [applyExchange]);

  const submitRecording = async () => {
    const blob = new Blob(chunksRef.current, {
      type: chunksRef.current[0]?.type || "audio/webm",
    });
    chunksRef.current = [];
    mediaRecorderRef.current = null;

    if (blob.size === 0) {
      setStatus("idle");
      return;
    }

    // Recorded while offline: park the audio in IndexedDB; the outbox drains
    // automatically and the answer arrives via the event listener above.
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      try {
        await enqueueExchange(blob, historyRef.current);
        appendNotice(
          "📴 Saved! I'll answer as soon as you're back online."
        );
      } catch {
        appendNotice("Oops! Couldn't save that. Please try again!");
      } finally {
        setStatus("idle");
      }
      return;
    }

    const formData = new FormData();
    formData.append(
      "audio",
      new File([blob], "speech.webm", { type: blob.type })
    );
    formData.append("history", JSON.stringify(historyRef.current));

    try {
      const res = await fetch("/api/conversation", {
        method: "POST",
        body: formData,
      });
      const data: ConversationResponse = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      applyExchange(data);
    } catch (err) {
      console.error("💥 [page] Conversation failed:", err);
      appendNotice("Oops! Something went wrong. Let's try again!");
    } finally {
      setStatus("idle");
    }
  };

  const startRecording = async () => {
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
      recorder.onstop = () => {
        void submitRecording();
      };
      recorder.start();

      mediaRecorderRef.current = recorder;
      setStatus("recording");
    } catch (err) {
      console.error("🎤 [page] Microphone access failed:", err);
      setStatus("idle");
    }
  };

  const stopRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    setStatus("processing");
    recorder.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

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
  }, [status]);

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

  const handleClearAll = () => {
    if (allMessages.length === 0) return;
    if (
      !window.confirm(
        "Delete ALL conversations? This cannot be undone."
      )
    )
      return;
    stopPlayback();
    clearAllMessages();
  };

  const handleNewChat = () => {
    stopPlayback();
    beginNewSession();
  };

  return (
    <main className="flex h-dvh flex-col bg-gradient-to-b from-blue-50 to-purple-50">
      {/* Header */}
      <header className="px-3 pt-6 pb-3 text-center">
        <h1 className="text-3xl font-bold text-gray-800">🎤 English Buddy</h1>
        <div className="mt-2 flex items-center justify-center gap-2 text-xs font-semibold">
          <span className="rounded-full bg-white px-2.5 py-1 text-orange-500 shadow-sm">
            🔥 {stats.currentStreak}-day streak
          </span>
          <span className="rounded-full bg-white px-2.5 py-1 text-amber-500 shadow-sm">
            🏆 {earnedBadgeCount}{" "}
            {earnedBadgeCount === 1 ? "badge" : "badges"}
          </span>
        </div>
        <p className="mt-2 text-sm text-gray-500">Press and hold to speak</p>
        <nav className="mt-2 flex flex-wrap items-center justify-center gap-1.5">
          <button
            type="button"
            onClick={() => setShowVideoCall(true)}
            className="rounded-full border border-pink-300 bg-pink-50 px-3 py-1.5 text-xs font-semibold text-pink-600 shadow-sm transition-colors hover:bg-pink-100"
          >
            📹 Video Call Prototype
          </button>
          <Link
            href="/dashboard"
            className="rounded-full border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 shadow-sm transition-colors hover:bg-gray-100"
          >
            📊 Dashboard
          </Link>
          <Link
            href="/history"
            className="rounded-full border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 shadow-sm transition-colors hover:bg-gray-100"
          >
            📜 History
          </Link>
          <button
            type="button"
            onClick={handleNewChat}
            className="rounded-full border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 shadow-sm transition-colors hover:bg-gray-100"
          >
            ✨ New
          </button>
          {allMessages.length > 0 && (
            <button
              type="button"
              onClick={handleClearAll}
              aria-label="Delete all conversations"
              className="rounded-full border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 shadow-sm transition-colors hover:bg-gray-100"
            >
              🗑️
            </button>
          )}
        </nav>
      </header>

      {/* Chat list */}
      <div className="flex-1 overflow-y-auto px-4 pb-32">
        <div className="mx-auto flex max-w-xl flex-col gap-3">
          {visibleMessages.length === 0 && status === "idle" && (
            <div className="flex flex-col items-start gap-1">
              <div className="max-w-[80%] rounded-2xl rounded-bl-sm bg-white px-4 py-2 text-gray-800 shadow">
                Hi! I&apos;m English Buddy. Press and hold the button below, then
                say &quot;Hello!&quot; 👋
              </div>
            </div>
          )}

          <ChatTranscript messages={visibleMessages} />

          {status === "processing" && (
            <div className="flex flex-col items-start gap-1">
              <div className="max-w-[80%] rounded-2xl rounded-bl-sm bg-white px-4 py-2 text-gray-400 shadow">
                Thinking…
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* Record button */}
      <button
        type="button"
        aria-label="Press and hold to speak"
        disabled={status === "processing"}
        onMouseDown={handleStartMouse}
        onMouseUp={handleStopMouse}
        onTouchStart={handleStartTouch}
        onTouchEnd={handleStopTouch}
        onContextMenu={(e) => e.preventDefault()}
        className={`fixed bottom-8 left-1/2 z-10 flex h-20 w-20 -translate-x-1/2 touch-none select-none items-center justify-center rounded-full text-3xl shadow-xl transition-all duration-200 ${
          status === "recording"
            ? "scale-125 bg-red-500 text-white"
            : status === "processing"
              ? "bg-gray-400 text-white"
              : "bg-blue-500 text-white hover:bg-blue-600"
        }`}
      >
        {status === "processing" ? "⏳" : "🎤"}
      </button>

      <InstallPrompt />

      <DigitalHumanCall
        open={showVideoCall}
        onClose={() => setShowVideoCall(false)}
      />
    </main>
  );
}
