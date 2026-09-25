"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { VoiceActivityDetector, VAD_CONFIG } from "@/lib/vad";
import { stopPlayback } from "@/lib/audioPlayer";
import {
  addCallExchange,
  appendNotice,
  beginCallSession,
  beginNewSession,
  finalizeCallSession,
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
  | "mic-denied"
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

interface Caption {
  id: number;
  user: string;
  buddy: string;
}

const HISTORY_LIMIT = 4;

/** Bound a single call to protect the child and limit API spend. */
const MAX_CALL_MS = 15 * 60_000;
/** "Call ending soon" heads-up before the hard cap. */
const CALL_WARN_MS = MAX_CALL_MS - 30_000;

/** Codec preference order — Opus/webm is the broadly supported best. */
const RECORDER_CODECS = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
] as const;

/**
 * MediaRecorder emits data in slices this small. All slices of ONE
 * continuous recorder session concatenate into a single valid container
 * (the first slice carries the header), which lets us keep recording while
 * an in-flight request is replaced by a longer, complete turn.
 */
const RECORDER_TIMESLICE_MS = 250;

/**
 * Extra wait after the VAD's trailing-silence endpoint before submitting.
 * The VAD closes after 700ms quiet; a child thinking between sentences
 * often pauses longer. If speech resumes within this grace window the turn
 * stays one continuous clip and no request is wasted.
 */
const ENDPOINT_GRACE_MS = 500;

function pickRecorderMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const candidate of RECORDER_CODECS) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      console.log("🎙️ [call] MediaRecorder codec selected:", candidate);
      return candidate;
    }
  }
  console.warn(
    "🎙️ [call] None of the preferred codecs are supported; using browser default"
  );
  return undefined;
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function AudioCall() {
  const { accent, voice } = useAccent();
  const allMessages = useMessages();

  const [phase, setPhase] = useState<Phase>("idle");
  const [muted, setMuted] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [endingSoon, setEndingSoon] = useState(false);
  const [captions, setCaptions] = useState<Caption[]>([]);

  // phase mirrored in a ref so rAF-driven VAD callbacks never read stale state
  const phaseRef = useRef<Phase>("idle");
  const setPhaseBoth = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  // Monotonic session token. Incremented on every start and every end;
  // any async callback from a previous session bails when it doesn't match.
  const sessionRef = useRef(0);
  const mutedRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const vadRef = useRef<VoiceActivityDetector | null>(null);
  const aiAudioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Pending "pause ended — about to submit" grace timer.
  const endpointTimerRef = useRef<number | null>(null);
  // submitTurn is declared after startTurnRecording; a ref breaks the cycle.
  const submitTurnRef = useRef<((session: number) => Promise<void>) | null>(
    null
  );
  const connectedAtRef = useRef<number | null>(null);
  const captionIdRef = useRef(0);
  // Persisted session row (type "call") for the currently active call.
  const callSessionIdRef = useRef<string | null>(null);
  const allMessagesRef = useRef(allMessages);
  const historyRef = useRef<{ role: "user" | "assistant"; content: string }[]>(
    []
  );

  // Seed history from recent messages so the call has context. A snapshot is
  // taken when a call starts; exchanges within the call then accumulate here,
  // keeping the API history identical to the persisted call transcript.
  useEffect(() => {
    allMessagesRef.current = allMessages;
    historyRef.current = allMessages.slice(-HISTORY_LIMIT).map((m) => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.text,
    }));
  }, [allMessages]);

  // ── Resource teardown (idempotent; safe for rapid start/end cycles) ──

  const releaseResources = useCallback(() => {
    vadRef.current?.stop();
    vadRef.current = null;
    // Unmount/hang-up while still on the permission prompt: close the
    // gesture-primed context that start() never got to consume.
    VoiceActivityDetector.cancelPrime();
    abortRef.current?.abort();
    abortRef.current = null;
    if (endpointTimerRef.current !== null) {
      window.clearTimeout(endpointTimerRef.current);
      endpointTimerRef.current = null;
    }
    const recorder = recorderRef.current;
    if (recorder) {
      // Discard: no submit from a torn-down recorder, no late chunk pushes.
      recorder.onstop = null;
      recorder.ondataavailable = null;
      if (recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          // already stopping
        }
      }
    }
    recorderRef.current = null;
    chunksRef.current = [];
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    const audio = aiAudioRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.src = "";
      aiAudioRef.current = null;
    }
    stopPlayback();
  }, []);

  // Persist the call's final metadata (or discard it if no speech happened).
  // "beacon" transport survives refresh / tab close via navigator.sendBeacon.
  const finalizeActiveCall = useCallback(
    (transport: "fetch" | "beacon" = "fetch") => {
      const sid = callSessionIdRef.current;
      if (sid === null) return;
      const durationMs = connectedAtRef.current
        ? Date.now() - connectedAtRef.current
        : 0;
      callSessionIdRef.current = null;
      finalizeCallSession(sid, durationMs, transport);
    },
    []
  );

  // Route change / unmount: release devices and finalize whatever was active.
  useEffect(() => {
    return () => {
      finalizeActiveCall("fetch");
      releaseResources();
    };
  }, [finalizeActiveCall, releaseResources]);

  // Browser refresh / tab close mid-call: per-exchange writes already landed;
  // send the final duration with a beacon so History keeps an accurate call.
  useEffect(() => {
    const onPageHide = () => {
      finalizeActiveCall("beacon");
      releaseResources();
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [finalizeActiveCall, releaseResources]);

  // ── Call timing ─────────────────────────────────────────────────────

  const endCallRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (
      phase !== "listening" &&
      phase !== "recording" &&
      phase !== "processing" &&
      phase !== "speaking"
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      const start = connectedAtRef.current;
      if (start === null) return;
      const ms = Date.now() - start;
      setElapsed(Math.floor(ms / 1000));
      if (!endingSoon && ms >= CALL_WARN_MS) {
        setEndingSoon(true);
        appendNotice(
          "⏰ Call ending in 30 seconds — say goodbye!",
          callSessionIdRef.current ?? undefined
        );
      }
      if (ms >= MAX_CALL_MS) {
        window.clearInterval(timer);
        endCallRef.current?.();
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [phase, endingSoon]);

  // ── Recording + submission ──────────────────────────────────────────

  // Cancel a pending endpoint submission (speech resumed during grace).
  const clearEndpointTimer = useCallback(() => {
    if (endpointTimerRef.current !== null) {
      window.clearTimeout(endpointTimerRef.current);
      endpointTimerRef.current = null;
    }
  }, []);

  /**
   * Retire the current turn's recorder WITHOUT submitting. Used when the
   * audio has already been snapshotted (reply on its way), on mute/cancel,
   * barge-in, and teardown.
   */
  const stopTurnRecorder = useCallback(() => {
    clearEndpointTimer();
    const recorder = recorderRef.current;
    if (recorder) {
      recorder.onstop = null;
      recorder.ondataavailable = null;
      if (recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          // already stopping
        }
      }
    }
    recorderRef.current = null;
    chunksRef.current = [];
  }, [clearEndpointTimer]);

  const startTurnRecording = useCallback(
    (session: number) => {
      if (sessionRef.current !== session) return;
      const existing = recorderRef.current;
      if (existing && existing.state === "recording") {
        // Same turn is already being captured (speech resumed while a
        // request was in flight, or inside the grace window) — keep it.
        if (phaseRef.current !== "recording") setPhaseBoth("recording");
        return;
      }
      const stream = streamRef.current;
      if (!stream) return;
      try {
        chunksRef.current = [];
        const mimeType = pickRecorderMimeType();
        const recorder = new MediaRecorder(
          stream,
          mimeType ? { mimeType } : undefined
        );
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        // Timesliced delivery: the recorder STAYS RUNNING across
        // between-sentence pauses and even across an aborted in-flight
        // request, so a multi-sentence turn is always one complete clip.
        recorder.start(RECORDER_TIMESLICE_MS);
        recorderRef.current = recorder;
        setPhaseBoth("recording");
      } catch (err) {
        console.error("📞 [call] Failed to start recorder:", err);
      }
    },
    [setPhaseBoth]
  );

  const submitTurn = useCallback(
    async (session: number) => {
      endpointTimerRef.current = null;
      if (sessionRef.current !== session) return;

      // Immutable snapshot of the turn so far. The recorder is NOT stopped:
      // if the child says another sentence while this request is in flight
      // the fetch is aborted and the SAME recorder's full audio is resent.
      const chunks = chunksRef.current.slice();

      if (chunks.length === 0) {
        stopTurnRecorder();
        setPhaseBoth("listening");
        return;
      }

      const mimeType = chunks[0]?.type || "audio/webm";
      const blob = new Blob(chunks, { type: mimeType });
      if (blob.size === 0) {
        stopTurnRecorder();
        setPhaseBoth("listening");
        return;
      }

      const ext = mimeType.includes("mp4")
        ? "m4a"
        : mimeType.includes("ogg")
          ? "ogg"
          : "webm";
      const formData = new FormData();
      formData.append(
        "audio",
        new File([blob], `speech.${ext}`, { type: mimeType })
      );
      formData.append("history", JSON.stringify(historyRef.current));
      formData.append("accent", accent);
      formData.append("voice", voice);

      setPhaseBoth("processing");
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch("/api/conversation", {
          method: "POST",
          body: formData,
          signal: controller.signal,
        });
        if (sessionRef.current !== session) return; // ended / superseded

        const data: ConversationResponse = await res.json();
        if (!res.ok || data.error) {
          throw new Error(data.error || `Request failed (${res.status})`);
        }

        const transcript = data.transcript ?? "";
        const aiText = data.aiText ?? "";

        // The complete turn audio was sent in the snapshot; retire the
        // recorder before the reply so a barge-in starts a fresh new turn.
        stopTurnRecorder();

        historyRef.current = [
          ...historyRef.current,
          { role: "user" as const, content: transcript },
          { role: "assistant" as const, content: aiText },
        ].slice(-HISTORY_LIMIT);

        const callSid = callSessionIdRef.current;
        if (callSid) {
          addCallExchange(callSid, {
            transcript,
            aiText,
            praise: data.feedback?.praise,
            correction: data.feedback?.correction,
            newWord: data.feedback?.newWord,
            audioBase64: data.audioBase64,
            accent: getAccentPreference().accent,
          });
        }

        setCaptions((prev) => {
          const next = [
            ...prev,
            { id: ++captionIdRef.current, user: transcript, buddy: aiText },
          ];
          return next.slice(-2);
        });

        setPhaseBoth("speaking");

        if (data.audioBase64) {
          const audioEl = new Audio(
            `data:audio/mpeg;base64,${data.audioBase64}`
          );
          aiAudioRef.current = audioEl;

          const resumeListening = () => {
            if (sessionRef.current !== session) return;
            if (aiAudioRef.current === audioEl) aiAudioRef.current = null;
            setPhaseBoth("listening");
            // Guard the AI's own audio tail from being re-detected.
            vadRef.current?.beginCooldown(VAD_CONFIG.cooldownMs);
          };

          audioEl.onended = resumeListening;
          audioEl.onerror = () => {
            console.error("🔊 [call] AI audio playback failed");
            resumeListening();
          };
          try {
            await audioEl.play();
          } catch (err) {
            console.warn("🔊 [call] AI playback could not start:", err);
            resumeListening();
          }
        } else {
          setPhaseBoth("listening");
          vadRef.current?.beginCooldown(VAD_CONFIG.cooldownMs);
        }
      } catch (err) {
        if (sessionRef.current !== session) return;
        // Turn extension: the child kept talking and the VAD cancelled this
        // request to resubmit the full clip. The recorder stays alive;
        // leave the phase as "recording" (set by the speech-start handler).
        if (controller.signal.aborted) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("📞 [call] Conversation failed:", err);
        appendNotice(
          "Oops! I didn't catch that. Let's try again!",
          callSessionIdRef.current ?? undefined
        );
        // Keep the recorder: if the child repeats, the whole turn is resent.
        setPhaseBoth("listening");
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [accent, voice, setPhaseBoth, stopTurnRecorder]
  );
  useEffect(() => {
    submitTurnRef.current = submitTurn;
  }, [submitTurn]);

  // ── Barge-in: user talks over Buddy's REPLY (a genuinely new turn) ──

  const bargeIn = useCallback(
    (session: number) => {
      if (sessionRef.current !== session) return;
      console.log("📞 [call] Barge-in detected — stopping Buddy");
      // 1) Kill AI audio immediately (detach onended so it can't reset state).
      const audioEl = aiAudioRef.current;
      if (audioEl) {
        audioEl.onended = null;
        audioEl.onerror = null;
        audioEl.pause();
        audioEl.src = "";
        aiAudioRef.current = null;
      }
      // 2) Cancel any just-returning reply playback setup.
      abortRef.current?.abort();
      abortRef.current = null;
      // 3) The previous turn is complete — retire its recorder, then start
      // capturing the new utterance as a fresh turn.
      stopTurnRecorder();
      startTurnRecording(session);
    },
    [startTurnRecording, stopTurnRecorder]
  );

  // ── VAD callbacks (created per session inside startCall) ────────────

  const startCall = useCallback(async () => {
    // Rapid Start → End → Start: always fully release the old session first.
    releaseResources();
    const session = sessionRef.current + 1;
    sessionRef.current = session;
    mutedRef.current = false;
    setMuted(false);
    setEndingSoon(false);
    setElapsed(0);
    setCaptions([]);
    setPhaseBoth("connecting");

    // Create the VAD's AudioContext synchronously, inside this click task:
    // a slow mic-permission prompt would otherwise leave it born suspended.
    VoiceActivityDetector.prime();

    let stream: MediaStream;
    try {
      const constraints: MediaStreamConstraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      };
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (sessionRef.current !== session) {
        // Ended while the permission prompt was open.
        stream.getTracks().forEach((t) => t.stop());
        VoiceActivityDetector.cancelPrime();
        return;
      }
      streamRef.current = stream;

      // Verify the browser actually honored the processing constraints.
      const settings = stream.getAudioTracks()[0]?.getSettings();
      if (settings) {
        for (const key of [
          "echoCancellation",
          "noiseSuppression",
          "autoGainControl",
        ] as const) {
          if (settings[key] === false) {
            console.warn(
              `⚠️ [call] Browser reported ${key}=false; audio quality may suffer`
            );
          }
        }
      }
    } catch (err) {
      if (sessionRef.current !== session) return;
      console.error("📞 [call] Microphone unavailable:", err);
      VoiceActivityDetector.cancelPrime();
      releaseResources();
      setPhaseBoth("mic-denied");
      return;
    }

    const vad = new VoiceActivityDetector({
      onSpeechStart: () => {
        if (sessionRef.current !== session || mutedRef.current) return;
        const p = phaseRef.current;
        if (p === "listening") {
          startTurnRecording(session);
        } else if (p === "recording") {
          // Resumed inside the endpoint grace window — keep one turn.
          clearEndpointTimer();
        } else if (p === "processing") {
          // Same turn continues after a between-sentence pause: cancel the
          // in-flight PARTIAL submission but keep recording, so the whole
          // multi-sentence clip is transcribed together on the next pause.
          abortRef.current?.abort();
          abortRef.current = null;
          startTurnRecording(session); // live recorder is kept
        } else if (p === "speaking") {
          bargeIn(session);
        }
      },
      onSpeechEnd: (reason) => {
        if (sessionRef.current !== session || mutedRef.current) return;
        if (phaseRef.current !== "recording") return;
        if (reason === "cancel") {
          // Sub-minimum click/pop: discard the recording, stay in call.
          stopTurnRecorder();
          setPhaseBoth("listening");
          return;
        }
        if (!recorderRef.current) {
          setPhaseBoth("listening");
          return;
        }
        // Wait out the grace window before submitting: another sentence
        // starting within it extends this turn instead of being chopped
        // into a separate (previously discarded) segment. The recorder
        // stays running and keeps capturing.
        clearEndpointTimer();
        endpointTimerRef.current = window.setTimeout(() => {
          endpointTimerRef.current = null;
          if (sessionRef.current !== session) return;
          void submitTurnRef.current?.(session);
        }, ENDPOINT_GRACE_MS);
      },
    });
    try {
      await vad.start(stream);
    } catch (err) {
      if (sessionRef.current !== session) return;
      console.error("📞 [call] VAD failed to start:", err);
      releaseResources();
      setPhaseBoth("mic-denied");
      return;
    }
    vadRef.current = vad;
    connectedAtRef.current = Date.now();
    // Persist the call session immediately (typed "call") so an interrupted
    // call still survives; every exchange below carries this explicit id.
    callSessionIdRef.current = beginCallSession(
      getAccentPreference().accent
    );
    // Start this call's AI context from the pre-call snapshot; the call's own
    // exchanges accumulate in historyRef as they land in the stored session.
    historyRef.current = allMessagesRef.current.slice(-HISTORY_LIMIT).map(
      (m) => ({
        role: m.role === "user" ? ("user" as const) : ("assistant" as const),
        content: m.text,
      })
    );
    setPhaseBoth("listening");
  }, [
    startTurnRecording,
    bargeIn,
    stopTurnRecorder,
    clearEndpointTimer,
    releaseResources,
    setPhaseBoth,
  ]);

  // ── Controls ────────────────────────────────────────────────────────

  const endCall = useCallback(() => {
    sessionRef.current += 1; // invalidate every in-flight callback
    finalizeActiveCall("fetch"); // record endedAt/durationMs (or discard)
    releaseResources();
    connectedAtRef.current = null;
    mutedRef.current = false;
    setMuted(false);
    setEndingSoon(false);
    setElapsed(0);
    setPhaseBoth("ended");
    // Next free-chat message starts a fresh chat session.
    beginNewSession();
  }, [finalizeActiveCall, releaseResources, setPhaseBoth]);
  useEffect(() => {
    endCallRef.current = endCall;
  }, [endCall]);

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    const vad = vadRef.current;
    if (next) {
      vad?.setEnabled(false);
      // Discard anything recorded so far — do NOT submit.
      stopTurnRecorder();
      if (phaseRef.current === "recording") setPhaseBoth("listening");
    } else {
      vad?.setEnabled(true);
      // Ignore the sound of tapping unmute.
      vad?.beginCooldown(150);
    }
  }, [setPhaseBoth, stopTurnRecorder]);

  // Keyboard: Esc ends, M mutes (only while in a call).
  useEffect(() => {
    const inCall =
      phase === "listening" ||
      phase === "recording" ||
      phase === "processing" ||
      phase === "speaking";
    if (!inCall) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        endCall();
      } else if (e.key === "m" || e.key === "M") {
        toggleMute();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, endCall, toggleMute]);

  // ── Presentation ────────────────────────────────────────────────────

  const inCall =
    phase === "listening" ||
    phase === "recording" ||
    phase === "processing" ||
    phase === "speaking";

  const statusText =
    phase === "connecting"
      ? "Joining call…"
      : phase === "listening"
        ? muted
          ? "Muted"
          : "Listening…"
        : phase === "recording"
          ? "I'm hearing you…"
          : phase === "processing"
            ? "Thinking…"
            : phase === "speaking"
              ? "Buddy is speaking…"
              : phase === "mic-denied"
                ? "Microphone needed"
                : phase === "ended"
                  ? "Call ended"
                  : "Tap to start a voice call";

  const avatar =
    phase === "recording"
      ? "🎙️"
      : phase === "processing"
        ? "💭"
        : phase === "speaking"
          ? "🐣"
          : "🐣";

  const ringClass =
    phase === "recording"
      ? "bg-red-500/20 ring-4 ring-red-400/50 scale-110"
      : phase === "speaking"
        ? "bg-blue-500/20 ring-4 ring-blue-400/40 scale-105"
        : phase === "processing"
          ? "bg-amber-500/10 ring-4 ring-amber-400/30"
          : inCall
            ? "bg-green-500/10 ring-4 ring-green-400/30"
            : "bg-slate-700/50";

  const dotClass =
    phase === "recording"
      ? "animate-pulse bg-red-400"
      : phase === "speaking"
        ? "bg-blue-400"
        : phase === "processing"
          ? "animate-pulse bg-amber-400"
          : phase === "listening"
            ? "bg-green-400"
            : "bg-slate-500";

  return (
    <div
      data-phase={phase}
      className="relative flex h-full flex-col overflow-hidden bg-gradient-to-b from-slate-800 to-slate-900"
    >
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between px-4 pt-4 pb-3 text-white">
        <div className="flex items-center gap-2">
          <span className="text-xl" aria-hidden>
            📞
          </span>
          <div>
            <h2 className="text-sm font-bold">Voice Call with Buddy</h2>
            <p
              className="flex items-center gap-1.5 text-[11px] text-slate-300"
              aria-live="polite"
            >
              <span className={`inline-block h-2 w-2 rounded-full ${dotClass}`} />
              {statusText}
            </p>
          </div>
        </div>
        {inCall && (
          <span
            className="rounded-full bg-white/10 px-2.5 py-1 font-mono text-xs tabular-nums text-slate-200"
            aria-label={`Call duration ${formatElapsed(elapsed)}`}
          >
            {formatElapsed(elapsed)}
          </span>
        )}
      </div>

      {/* Stage */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 pb-4">
        <div className="relative flex h-40 w-40 items-center justify-center">
          {/* Pulsing rings while actively in a call */}
          {inCall && !muted && (
            <span
              aria-hidden
              className={`absolute inset-0 animate-ping rounded-full ${
                phase === "recording"
                  ? "bg-red-400/15"
                  : phase === "speaking"
                    ? "bg-blue-400/15"
                    : phase === "processing"
                      ? "bg-amber-400/10"
                      : "bg-green-400/15"
              }`}
            />
          )}
          <div
            className={`relative flex h-40 w-40 items-center justify-center rounded-full text-7xl shadow-2xl transition-all duration-300 ${ringClass} ${
              muted ? "opacity-60 grayscale" : ""
            }`}
          >
            {muted ? "🔇" : avatar}
          </div>
        </div>

        <p className="mt-5 text-center text-sm text-slate-300">
          {phase === "idle"
            ? "Just start talking — Buddy will listen and reply automatically."
            : phase === "connecting"
              ? "Requesting microphone access…"
              : phase === "mic-denied"
                ? "Buddy needs your microphone to hear you speak."
                : muted
                  ? "You're muted. Tap 🎤 to keep talking."
                  : phase === "recording"
                    ? "Keep talking. Pause and Buddy will answer."
                    : phase === "processing"
                      ? "Thinking of a reply…"
                    : phase === "speaking"
                      ? "Buddy is speaking — talk anytime to interrupt."
                      : phase === "ended"
                        ? "Call ended. Tap Start to call again."
                        : "Listening for your voice…"}
        </p>

        {/* Live captions (last 2 exchanges, older fades) */}
        <div
          aria-live="polite"
          className="mt-6 w-full max-w-md space-y-2"
        >
          {captions.map((c, i) => {
            const older = i < captions.length - 1;
            return (
              <div
                key={c.id}
                className={`space-y-1.5 transition-opacity duration-500 ${
                  older ? "opacity-50" : "opacity-100"
                }`}
              >
                {c.user && (
                  <div className="rounded-2xl bg-white/10 px-4 py-2 text-sm text-slate-100">
                    <span className="font-bold">🧒 You:</span> {c.user}
                  </div>
                )}
                {c.buddy && (
                  <div className="rounded-2xl bg-blue-500/20 px-4 py-2 text-sm text-blue-50">
                    <span className="font-bold">🐣 Buddy:</span> {c.buddy}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {endingSoon && inCall && (
          <p className="mt-4 rounded-xl bg-amber-400/15 px-3 py-2 text-center text-xs font-medium text-amber-200">
            ⏰ This call will end soon (15-minute limit).
          </p>
        )}

        {phase === "mic-denied" && (
          <div className="mt-5 flex flex-col items-center gap-3">
            <p className="max-w-sm rounded-2xl bg-white/10 px-4 py-3 text-center text-sm text-slate-200">
              I can&apos;t start the call without microphone permission.
              Please allow microphone access in your browser settings, then tap
              Try again.
            </p>
            <button
              type="button"
              onClick={startCall}
              className="rounded-full bg-green-500 px-6 py-3 text-sm font-bold text-white shadow-lg transition-all hover:bg-green-600 active:scale-95"
            >
              🔄 Try again
            </button>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="flex shrink-0 items-center justify-center gap-5 px-4 pb-6">
        {phase === "idle" && (
          <button
            type="button"
            onClick={startCall}
            className="flex items-center gap-2 rounded-full bg-green-500 px-8 py-4 text-base font-bold text-white shadow-lg transition-all hover:bg-green-600 active:scale-95"
          >
            📞 Start Call
          </button>
        )}

        {phase === "ended" && (
          <button
            type="button"
            onClick={startCall}
            className="flex items-center gap-2 rounded-full bg-green-500 px-8 py-4 text-base font-bold text-white shadow-lg transition-all hover:bg-green-600 active:scale-95"
          >
            📞 Call Again
          </button>
        )}

        {inCall && (
          <>
            <button
              type="button"
              onClick={toggleMute}
              aria-pressed={muted}
              aria-label={muted ? "Unmute microphone (M)" : "Mute microphone (M)"}
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
              aria-label="End call (Escape)"
              className="flex h-16 w-16 items-center justify-center rounded-full bg-red-500 text-2xl text-white shadow-lg transition-all hover:bg-red-600 active:scale-95"
            >
              📴
            </button>
          </>
        )}
      </div>

      <p className="shrink-0 pb-3 text-center text-[10px] text-slate-400/70">
        Automatic speech detection · echo cancellation on · Esc to hang up
      </p>
    </div>
  );
}
