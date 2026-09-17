"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ChatTranscript from "@/components/ChatTranscript";
import AccentPicker from "@/components/AccentPicker";
import InstallPrompt from "@/components/InstallPrompt";
import {
  addExchange,
  appendNotice,
  beginNewSession,
  lastChatSessionId,
  useMessages,
  usePendingNewSession,
} from "@/lib/messageStore";
import { playClip, stopPlayback } from "@/lib/audioPlayer";
import { enqueueExchange } from "@/lib/offlineQueue";
import { getAccentPreference, useAccent } from "@/lib/accentStore";

interface ConversationResponse {
  transcript?: string;
  aiText?: string;
  feedback?: {
    praise?: string;
    correction?: string;
    newWord?: string;
  };
  audioBase64?: string;
  /** Present on exchanges drained from the offline outbox. */
  accent?: string;
  error?: string;
}

type Status = "idle" | "recording" | "processing";

const HISTORY_LIMIT = 4;
// Ignore synthetic mouse events fired right after touch events on mobile.
const TOUCH_MOUSE_GRACE_MS = 800;

export default function ChatPage() {
  const allMessages = useMessages();
  const pendingNew = usePendingNewSession();
  const { accent, gender } = useAccent();
  const [status, setStatus] = useState<Status>("idle");

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const lastTouchAtRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Home shows the latest CHAT session (lessons never appear here); "New chat"
  // shows an empty conversation until the child speaks again.
  const { visibleMessages } = useMemo(() => {
    const sid = pendingNew ? null : lastChatSessionId(allMessages);
    return {
      visibleMessages: sid
        ? allMessages.filter((m) => m.sessionId === sid)
        : [],
    };
  }, [allMessages, pendingNew]);

  // Keep the latest few messages available for the API history parameter.
  const historyRef = useRef<{ role: "user" | "assistant"; content: string }[]>(
    []
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
      accent: data.accent ?? getAccentPreference().accent,
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
        await enqueueExchange(blob, historyRef.current, accent, gender);
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
    formData.append("accent", accent);
    formData.append("gender", gender);

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
      console.error("💬 [chat] Conversation failed:", err);
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
      console.error("🎤 [chat] Microphone access failed:", err);
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

  const handleNewChat = () => {
    stopPlayback();
    beginNewSession();
  };

  return (
    <main className="flex h-full flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-4 pb-2 pt-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-blue-100 to-purple-100 text-xl shadow-sm">
            🐣
          </div>
          <div>
            <h1 className="text-on-bg text-lg font-bold leading-tight">
              English Buddy
            </h1>
            <p className="text-xs text-gray-400">
              {status === "recording"
                ? "Listening…"
                : status === "processing"
                  ? "Thinking…"
                  : "Press and hold to speak"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <AccentPicker compact />
          <button
            type="button"
            onClick={handleNewChat}
            aria-label="Start a new chat"
            className="flex h-9 items-center gap-1 rounded-full bg-white px-3.5 text-sm font-semibold text-gray-600 shadow-sm transition-colors hover:bg-gray-50"
          >
            ✨ New
          </button>
        </div>
      </header>

      {/* Chat list */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        <div className="mx-auto flex max-w-xl flex-col gap-3">
          {visibleMessages.length === 0 && status === "idle" && (
            <div className="flex flex-col items-center gap-3 pt-6">
              <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-white px-4 py-2.5 text-center text-gray-800 shadow-sm">
                Hi! I&apos;m English Buddy. Press and hold the button below, then
                say &quot;Hello!&quot; 👋
              </div>
              <span aria-hidden className="animate-bounce text-2xl">
                👇
              </span>
              <p className="text-xs font-medium text-gray-400">
                Hold the big 🎤 button to talk to me!
              </p>
            </div>
          )}

          <ChatTranscript messages={visibleMessages} />

          {status === "processing" && (
            <div className="flex flex-col items-start gap-1">
              <div className="max-w-[80%] rounded-2xl rounded-bl-sm bg-white px-4 py-2.5 text-gray-400 shadow-sm">
                Thinking…
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* Record button (in-flow, sits above the tab bar) */}
      <div className="flex shrink-0 justify-center pb-3">
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
      </div>

      <InstallPrompt />
    </main>
  );
}
