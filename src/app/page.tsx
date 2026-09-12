"use client";

import { useEffect, useRef, useState } from "react";

interface ChatMessage {
  role: "user" | "ai";
  text: string;
  praise?: string;
  correction?: string;
  newWord?: string;
}

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

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<Status>("idle");

  const messagesRef = useRef<ChatMessage[]>([]);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const lastTouchAtRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, status]);

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

    const history = messagesRef.current
      .slice(-HISTORY_LIMIT)
      .map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.text }));

    const formData = new FormData();
    formData.append("audio", new File([blob], "speech.webm", { type: blob.type }));
    formData.append("history", JSON.stringify(history));

    try {
      const res = await fetch("/api/conversation", {
        method: "POST",
        body: formData,
      });
      const data: ConversationResponse = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || `Request failed (${res.status})`);
      }

      setMessages((prev) => [
        ...prev,
        { role: "user", text: data.transcript ?? "" },
        {
          role: "ai",
          text: data.aiText ?? "",
          praise: data.feedback?.praise,
          correction: data.feedback?.correction,
          newWord: data.feedback?.newWord,
        },
      ]);

      if (data.audioBase64) {
        const audio = new Audio(`data:audio/mpeg;base64,${data.audioBase64}`);
        void audio.play().catch(() => {});
      }
    } catch (err) {
      console.error("💥 [page] Conversation failed:", err);
      setMessages((prev) => [
        ...prev,
        { role: "ai", text: "Oops! Something went wrong. Let's try again!" },
      ]);
    } finally {
      setStatus("idle");
    }
  };

  const startRecording = async () => {
    if (status !== "idle") return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      const mimeType = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : undefined;
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  return (
    <main className="flex h-dvh flex-col bg-gradient-to-b from-blue-50 to-purple-50">
      {/* Header */}
      <header className="pt-8 pb-4 text-center">
        <h1 className="text-3xl font-bold text-gray-800">🎤 English Buddy</h1>
        <p className="mt-1 text-sm text-gray-500">Press and hold to speak</p>
      </header>

      {/* Chat list */}
      <div className="flex-1 overflow-y-auto px-4 pb-32">
        <div className="mx-auto flex max-w-xl flex-col gap-3">
          {messages.length === 0 && (
            <div className="flex flex-col items-start gap-1">
              <div className="max-w-[80%] rounded-2xl rounded-bl-sm bg-white px-4 py-2 text-gray-800 shadow">
                Hi! I&apos;m English Buddy. Press and hold the button below, then
                say &quot;Hello!&quot; 👋
              </div>
            </div>
          )}

          {messages.map((message, index) =>
            message.role === "user" ? (
              <div key={index} className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-blue-500 px-4 py-2 text-white shadow">
                  {message.text}
                </div>
              </div>
            ) : (
              <div key={index} className="flex flex-col items-start gap-1">
                <div className="max-w-[80%] rounded-2xl rounded-bl-sm bg-white px-4 py-2 text-gray-800 shadow">
                  {message.text}
                </div>
                {(message.praise || message.correction || message.newWord) && (
                  <div className="max-w-[80%] space-y-0.5 px-1 text-xs text-gray-500">
                    {message.praise && message.praise !== "None" && (
                      <p>✅ {message.praise}</p>
                    )}
                    {message.correction && message.correction !== "None" && (
                      <p>✏️ {message.correction}</p>
                    )}
                    {message.newWord && message.newWord !== "None" && (
                      <p>💡 {message.newWord}</p>
                    )}
                  </div>
                )}
              </div>
            )
          )}

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
    </main>
  );
}
