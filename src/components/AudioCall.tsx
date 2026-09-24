"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { VoiceActivityDetector } from "@/lib/vad";
import { playClip, stopPlayback } from "@/lib/audioPlayer";
import {
  addExchange,
  appendNotice,
  beginNewSession,
  useMessages,
} from "@/lib/messageStore";
import { getAccentPreference, useAccent } from "@/lib/accentStore";

type Phase =
  | "idle"
  | "connecting"
  | "listening"
  | "recording"
  | "processing"
  | "speaking"
  | "ended";

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

const HISTORY_LIMIT = 4;

export default function AudioCall() {
  const { accent, voice } = useAccent();
  const allMessages = useMessages();
  const [phase, setPhase] = useState<Phase>("idle");
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [caption, setCaption] = useState<{ user: string; buddy: string } | null>(
    null
  );

  // Refs mirror state so the VAD callbacks (fired from rAF) read fresh values
  // without stale closures.
  const phaseRef = useRef<Phase>("idle");
  const mutedRef = useRef(false);
  const setPhaseBoth = (p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  };

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const vadRef = useRef<VoiceActivityDetector | null>(null);
  const aiAudioRef = useRef<HTMLAudioElement | null>(null);
  // Keep the call's recent exchanges for the API history parameter.
  const historyRef = useRef<{ role: "user" | "assistant"; content: string }[]>(
    []
  );

  // Seed history from the latest chat session so the call has context.
  useEffect(() => {
    historyRef.current = allMessages.slice(-HISTORY_LIMIT).map((m) => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.text,
    }));
  }, [allMessages]);

  const teardown = useCallback(() => {
    vadRef.current?.setMuted(true);
    vadRef.current?.stop();
    vadRef.current = null;
    recorderRef.current?.stop();
    recorderRef.current = null;
    chunksRef.current = [];
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (aiAudioRef.current) {
      aiAudioRef.current.onended = null;
      aiAudioRef.current.pause();
      aiAudioRef.current.src = "";
      aiAudioRef.current = null;
    }
    stopPlayback();
  }, []);

  // Clean up on unmount.
  useEffect(() => () => teardown(), [teardown]);

  const submitSegment = useCallback(async () => {
    const blob = new Blob(chunksRef.current, {
      type: chunksRef.current[0]?.type || "audio/webm",
    });
    chunksRef.current = [];
    recorderRef.current = null;

    if (blob.size === 0) {
      setPhaseBoth("listening");
      vadRef.current?.setMuted(mutedRef.current);
      return;
    }

    const formData = new FormData();
    formData.append(
      "audio",
      new File([blob], "speech.webm", { type: blob.type })
    );
    formData.append("history", JSON.stringify(historyRef.current));
    formData.append("accent", accent);
    formData.append("voice", voice);

    try {
      const res = await fetch("/api/conversation", {
        method: "POST",
        body: formData,
      });
      const data: ConversationResponse = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || `Request failed (${res.status})`);
      }

      const transcript = data.transcript ?? "";
      const aiText = data.aiText ?? "";

      historyRef.current = [
        ...historyRef.current,
        { role: "user" as const, content: transcript },
        { role: "assistant" as const, content: aiText },
      ].slice(-HISTORY_LIMIT);

      // Persist to the shared message store so the call shows in History.
      const { ai } = addExchange({
        transcript,
        aiText,
        praise: data.feedback?.praise,
        correction: data.feedback?.correction,
        newWord: data.feedback?.newWord,
        audioBase64: data.audioBase64,
        accent: getAccentPreference().accent,
      });

      setCaption({ user: transcript, buddy: aiText });
      setPhaseBoth("speaking");

      if (data.audioBase64) {
        const audio = new Audio(
          `data:audio/mpeg;base64,${data.audioBase64}`
        );
        aiAudioRef.current = audio;
        audio.onended = () => {
          aiAudioRef.current = null;
          // Resume listening after Buddy finishes talking.
          setPhaseBoth("listening");
          vadRef.current?.setMuted(mutedRef.current);
        };
        audio.onerror = () => {
          console.error("🔊 [call] AI audio playback failed");
          aiAudioRef.current = null;
          setPhaseBoth("listening");
          vadRef.current?.setMuted(mutedRef.current);
        };
        void audio.play().catch((err) => {
          console.warn("🔊 [call] Autoplay blocked:", err);
          // Fall back to the global player (user can tap to retry there).
          if (ai.audioBase64) playClip(ai.id, `data:audio/mpeg;base64,${ai.audioBase64}`);
          setPhaseBoth("listening");
          vadRef.current?.setMuted(mutedRef.current);
        });
      } else {
        // No audio (TTS failed): still show text and keep listening.
        setPhaseBoth("listening");
        vadRef.current?.setMuted(mutedRef.current);
      }
    } catch (err) {
      console.error("📞 [call] Conversation failed:", err);
      appendNotice("Oops! I didn't catch that. Let's try again!");
      setPhaseBoth("listening");
      vadRef.current?.setMuted(mutedRef.current);
    }
  }, [accent, voice]);

  // VAD callbacks.
  const onSpeechStart = useCallback(() => {
    if (phaseRef.current !== "listening") return;
    const stream = streamRef.current;
    if (!stream) return;
    try {
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
      recorder.onstop = () => void submitSegment();
      recorder.start();
      recorderRef.current = recorder;
      setPhaseBoth("recording");
    } catch (err) {
      console.error("📞 [call] Failed to start recorder:", err);
    }
  }, [submitSegment]);

  const onSpeechEnd = useCallback(() => {
    if (phaseRef.current !== "recording") return;
    // Mute VAD while we submit + Buddy replies so the AI's voice from the
    // speakers isn't picked up and re-submitted.
    vadRef.current?.setMuted(true);
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    } else {
      chunksRef.current = [];
      recorderRef.current = null;
      setPhaseBoth("listening");
      vadRef.current?.setMuted(mutedRef.current);
    }
    setPhaseBoth("processing");
  }, []);

  const startCall = useCallback(async () => {
    setError(null);
    setPhaseBoth("connecting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const vad = new VoiceActivityDetector({
        onSpeechStart,
        onSpeechEnd,
      });
      await vad.start(stream);
      vadRef.current = vad;

      setCaption(null);
      setPhaseBoth("listening");
    } catch (err) {
      console.error("📞 [call] Mic access failed:", err);
      setError(
        "Please allow microphone access so Buddy can hear you."
      );
      setPhaseBoth("idle");
    }
  }, [onSpeechStart, onSpeechEnd]);

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    if (next) {
      // Muting: stop any in-progress recording (discard it) and pause VAD.
      vadRef.current?.setMuted(true);
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null; // don't submit
        recorder.stop();
      }
      recorderRef.current = null;
      chunksRef.current = [];
      if (phaseRef.current === "recording") {
        setPhaseBoth("listening");
      }
    } else {
      // Unmuting: resume VAD if we're idle/listening.
      if (phaseRef.current === "listening") {
        vadRef.current?.setMuted(false);
      }
    }
  }, []);

  const endCall = useCallback(() => {
    teardown();
    setPhaseBoth("ended");
    setMuted(false);
    mutedRef.current = false;
    setCaption(null);
    // The next call should be a fresh conversation session.
    beginNewSession();
  }, [teardown]);

  const restartCall = useCallback(() => {
    setError(null);
    setCaption(null);
    setPhaseBoth("idle");
  }, []);

  const inCall =
    phase !== "idle" && phase !== "connecting" && phase !== "ended";
  const statusText =
    phase === "connecting"
      ? "Joining call…"
      : phase === "listening"
        ? muted
          ? "Muted"
          : "Listening…"
        : phase === "recording"
          ? "You're talking…"
          : phase === "processing"
            ? "Buddy is thinking…"
            : phase === "speaking"
              ? "Buddy is talking…"
              : phase === "ended"
                ? "Call ended"
                : "Tap to start a voice call";

  return (
    <div className="flex h-full flex-col bg-gradient-to-b from-slate-800 to-slate-900">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between px-4 pt-4 pb-3 text-white">
        <div className="flex items-center gap-2">
          <span className="text-xl">📞</span>
          <div>
            <h2 className="text-sm font-bold">Voice Call with Buddy</h2>
            <p className="flex items-center gap-1.5 text-[11px] text-slate-300">
              <span
                className={`inline-block h-2 w-2 rounded-full ${
                  phase === "speaking"
                    ? "bg-blue-400"
                    : phase === "recording"
                      ? "animate-pulse bg-red-400"
                      : phase === "listening"
                        ? "bg-green-400"
                        : phase === "processing"
                          ? "animate-pulse bg-amber-400"
                          : "bg-slate-500"
                }`}
              />
              {statusText}
            </p>
          </div>
        </div>
      </div>

      {/* Stage: avatar + live captions */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 pb-4">
        <div
          className={`relative flex h-40 w-40 items-center justify-center rounded-full text-7xl shadow-2xl transition-all duration-300 ${
            phase === "recording"
              ? "scale-110 bg-red-500/20 ring-4 ring-red-400/40"
              : phase === "speaking"
                ? "scale-105 bg-blue-500/20 ring-4 ring-blue-400/40"
                : phase === "processing"
                  ? "bg-amber-500/10 ring-4 ring-amber-400/30"
                  : inCall
                    ? "bg-green-500/10 ring-4 ring-green-400/30"
                    : "bg-slate-700/50"
          }`}
        >
          {phase === "recording" ? "🎙️" : phase === "speaking" ? "🗣️" : "🐣"}
        </div>

        <p className="mt-5 text-center text-sm text-slate-300">
          {phase === "idle"
            ? "Just start talking — Buddy will listen and reply automatically."
            : phase === "connecting"
              ? "Requesting microphone access…"
              : muted
                ? "Tap the microphone to unmute"
                : phase === "recording"
                  ? "Keep talking. Pause and Buddy will answer."
                  : phase === "processing"
                    ? "Thinking of a reply…"
                    : phase === "speaking"
                      ? "Buddy is speaking…"
                      : phase === "ended"
                        ? "Call ended. Tap Start to call again."
                        : "Listening for your voice…"}
        </p>

        {/* Live captions */}
        <div className="mt-6 w-full max-w-md space-y-2">
          {caption?.user && (
            <div className="rounded-2xl bg-white/10 px-4 py-2.5 text-sm text-slate-100">
              <span className="font-bold">🧒 You:</span> {caption.user}
            </div>
          )}
          {caption?.buddy && (
            <div className="rounded-2xl bg-blue-500/20 px-4 py-2.5 text-sm text-blue-50">
              <span className="font-bold">🐣 Buddy:</span> {caption.buddy}
            </div>
          )}
        </div>

        {error && (
          <p className="mt-4 max-w-md rounded-xl bg-red-500/20 px-3 py-2 text-center text-xs font-medium text-red-200">
            ⚠️ {error}
          </p>
        )}
      </div>

      {/* Controls */}
      <div className="flex shrink-0 items-center justify-center gap-5 px-4 pb-6">
        {(phase === "idle" || phase === "ended") && (
          <button
            type="button"
            onClick={phase === "ended" ? restartCall : startCall}
            className="flex items-center gap-2 rounded-full bg-green-500 px-8 py-4 text-base font-bold text-white shadow-lg transition-all hover:bg-green-600 active:scale-95"
          >
            📞 {phase === "ended" ? "Call Again" : "Start Call"}
          </button>
        )}

        {inCall && (
          <>
            <button
              type="button"
              onClick={toggleMute}
              aria-pressed={muted}
              aria-label={muted ? "Unmute" : "Mute"}
              className={`flex h-16 w-16 items-center justify-center rounded-full text-2xl shadow-lg transition-all active:scale-95 ${
                muted
                  ? "bg-red-500 text-white hover:bg-red-600"
                  : "bg-white/15 text-white hover:bg-white/25"
              }`}
            >
              {muted ? "🔇" : "🎤"}
            </button>
            <button
              type="button"
              onClick={endCall}
              aria-label="End call"
              className="flex h-16 w-16 items-center justify-center rounded-full bg-red-500 text-2xl text-white shadow-lg transition-all hover:bg-red-600 active:scale-95"
            >
              📴
            </button>
          </>
        )}
      </div>

      <p className="shrink-0 pb-3 text-center text-[10px] text-slate-400/70">
        Voice: automatic speech detection · no need to press and hold
      </p>
    </div>
  );
}
