"use client";

import { useState } from "react";
import type { ChatMessage } from "@/lib/messageStore";
import { setMessageAudio } from "@/lib/messageStore";
import { playClip, stopPlayback, usePlayingMessageId } from "@/lib/audioPlayer";
import { displayParts } from "@/lib/feedbackParser";
import { useAccent } from "@/lib/accent";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function ListenButton({
  message,
  speakText,
}: {
  message: ChatMessage;
  speakText: string;
}) {
  const playingId = usePlayingMessageId();
  const accent = useAccent();
  const [loading, setLoading] = useState(false);
  const isPlaying = playingId === message.id;

  const handleClick = async () => {
    if (isPlaying) {
      stopPlayback();
      return;
    }
    let src: string;
    if (message.audioBase64) {
      src = `data:audio/mpeg;base64,${message.audioBase64}`;
    } else {
      // Clip was never stored or was evicted by quota — re-synthesize.
      setLoading(true);
      try {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: speakText, accent }),
        });
        const data: { audioBase64?: string; error?: string } =
          await res.json();
        if (!res.ok || !data.audioBase64) {
          throw new Error(data.error || `TTS failed (${res.status})`);
        }
        setMessageAudio(message.id, data.audioBase64);
        src = `data:audio/mpeg;base64,${data.audioBase64}`;
      } catch (err) {
        console.error("🔊 [transcript] Replay failed:", err);
        setLoading(false);
        return;
      }
    }
    setLoading(false);
    playClip(message.id, src);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`mt-1 rounded-full px-2 py-0.5 text-xs font-medium transition-colors ${
        isPlaying
          ? "bg-blue-100 text-blue-700"
          : "text-blue-500 hover:bg-blue-50"
      }`}
    >
      {loading ? "⏳ Loading…" : isPlaying ? "⏸ Stop" : "🔊 Listen"}
    </button>
  );
}

export default function ChatTranscript({
  messages,
}: {
  messages: ChatMessage[];
}) {
  return (
    <>
      {messages.map((message) =>
        message.role === "user" ? (
          <div key={message.id} className="flex flex-col items-end gap-0.5">
            <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-blue-500 px-4 py-2 text-white shadow">
              {message.text}
            </div>
            <span className="pr-1 text-[10px] text-gray-400">
              {formatTime(message.createdAt)}
            </span>
          </div>
        ) : (
          <AiMessage key={message.id} message={message} />
        )
      )}
    </>
  );
}

function AiMessage({ message }: { message: ChatMessage }) {
  // Pulls structured feedback into chips; also repairs legacy messages
  // whose bubble text contains PRAISE:/CORRECTION:/NEW_WORD: inline.
  const parts = displayParts({
    text: message.text,
    praise: message.praise,
    correction: message.correction,
    newWord: message.newWord,
  });

  return (
    <div className="flex flex-col items-start gap-1">
      <div className="max-w-[80%] rounded-2xl rounded-bl-sm bg-white px-4 py-2 text-gray-800 shadow-sm">
        {parts.text}
      </div>
      {(parts.praise || parts.correction || parts.newWord) && (
        <div className="flex max-w-[80%] flex-wrap gap-1 px-1">
          {parts.praise && (
            <span className="rounded-full bg-green-50 px-2.5 py-1 text-[11px] font-medium leading-tight text-green-600">
              ✅ {parts.praise}
            </span>
          )}
          {parts.correction && (
            <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-medium leading-tight text-amber-600">
              ✏️ {parts.correction}
            </span>
          )}
          {parts.newWord && (
            <span className="rounded-full bg-purple-50 px-2.5 py-1 text-[11px] font-medium leading-tight text-purple-600">
              💡 {parts.newWord}
            </span>
          )}
        </div>
      )}
      <div className="flex items-center gap-2 px-1">
        <ListenButton message={message} speakText={parts.text} />
        <span className="text-[10px] text-gray-400">
          {formatTime(message.createdAt)}
        </span>
      </div>
    </div>
  );
}
