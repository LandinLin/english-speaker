"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { VoiceActivityDetector, VAD_CONFIG } from "@/lib/vad";
import { estimateSentenceBoundaries } from "@/lib/sentenceBoundaries";
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

/**
 * While Buddy is speaking, the VAD's start-confirm window is raised to this
 * value: speech must be sustained at least this long before onSpeechStart
 * fires at all, so "hmm"s, coughs and background chatter are ignored
 * entirely and Buddy keeps talking unaffected. Trade-off: the first
 * fraction of a second of a genuine interruption's onset is clipped,
 * because recording starts when the VAD confirms.
 */
const INTERRUPT_DEBOUNCE_MS = 500;

/**
 * A child talking continuously over Buddy for this long is not an
 * interruption but a takeover: Buddy's audio is hard-cut and the captured
 * speech is submitted immediately instead of waiting for a sentence end.
 */
const TAKEOVER_MS = 5_000;

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
  // True while a committed interruption is being captured and Buddy is
  // still finishing his current sentence. Drives the queued-speech hint.
  const [interruptPending, setInterruptPending] = useState(false);

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
  // ── Interruption-during-speech tracking ──
  const interruptPendingRef = useRef(false);
  // Wall-clock of the first loud frame of the current interruption attempt
  // (basis for the takeover cap); 0 = none.
  const interruptFirstDetectAtRef = useRef(0);
  // Wall-clock of when the child last paused mid-interruption; 0 = talking.
  const interruptEndedAtRef = useRef(0);
  // Sentence end-times (ms) of the reply currently playing + next index.
  const boundariesRef = useRef<number[]>([]);
  const nextBoundaryIndexRef = useRef(0);
  const boundaryRafRef = useRef<number | null>(null);
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

  /** Stop the sentence-boundary watcher for the currently playing reply. */
  const stopBoundaryWatch = useCallback(() => {
    if (boundaryRafRef.current !== null) {
      cancelAnimationFrame(boundaryRafRef.current);
      boundaryRafRef.current = null;
    }
  }, []);

  /** Detach and release the AI reply audio element, if any. */
  const releaseAiAudio = useCallback(() => {
    const audio = aiAudioRef.current;
    if (audio) {
      audio.onloadedmetadata = null;
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.src = "";
      aiAudioRef.current = null;
    }
    stopBoundaryWatch();
  }, [stopBoundaryWatch]);

  /** Forget any pending/committed interruption state (teardown, mute). */
  const clearInterruption = useCallback(() => {
    interruptFirstDetectAtRef.current = 0;
    interruptEndedAtRef.current = 0;
    interruptPendingRef.current = false;
    setInterruptPending(false);
  }, []);

  const releaseResources = useCallback(() => {
    vadRef.current?.stop();
    vadRef.current = null;
    // Unmount/hang-up while still on the permission prompt: close the
    // gesture-primed context that start() never got to consume.
    VoiceActivityDetector.cancelPrime();
    abortRef.current?.abort();
    abortRef.current = null;
    clearInterruption();
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
    releaseAiAudio();
    stopPlayback();
  }, [clearInterruption, releaseAiAudio]);

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

  // Schedule the endpoint-grace submission of the current turn.
  const scheduleEndpointSubmit = useCallback(
    (session: number) => {
      if (endpointTimerRef.current !== null) {
        window.clearTimeout(endpointTimerRef.current);
      }
      endpointTimerRef.current = window.setTimeout(() => {
        endpointTimerRef.current = null;
        if (sessionRef.current !== session) return;
        void submitTurnRef.current?.(session);
      }, ENDPOINT_GRACE_MS);
    },
    []
  );

  const startTurnRecording = useCallback(
    (session: number, opts?: { announce?: boolean }) => {
      if (sessionRef.current !== session) return;
      // announce=false keeps the current phase (used while Buddy is still
      // finishing a sentence): the recorder runs but the UI stays "speaking".
      const announce = opts?.announce !== false;
      const existing = recorderRef.current;
      if (existing && existing.state === "recording") {
        // Same turn is already being captured (speech resumed while a
        // request was in flight, or inside the grace window) — keep it.
        if (announce && phaseRef.current !== "recording") {
          setPhaseBoth("recording");
        }
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
        if (announce) setPhaseBoth("recording");
      } catch (err) {
        console.error("📞 [call] Failed to start recorder:", err);
      }
    },
    [setPhaseBoth]
  );

  // ── Interruption while Buddy is speaking ───────────────────────────
  //
  // Speech during the reply NEVER cuts Buddy off mid-sentence. While Buddy
  // talks, the VAD's confirm window is raised to INTERRUPT_DEBOUNCE_MS so
  // short noises never surface; sustained speech commits an interruption
  // (recording starts there, unannounced) and, when playback crosses the
  // next sentence boundary, Buddy pauses and the child gets the floor.
  // Continuous talk past TAKEOVER_MS is a takeover: hard cut + submit.

  /**
   * Buddy yields: stop the reply audio and give the child the floor.
   * takeover=true submits the captured speech immediately; otherwise the
   * normal endpoint flow submits it once the child pauses (or right away
   * via the grace timer if the child already paused mid-interruption).
   */
  const finishInterruption = useCallback(
    (session: number, takeover: boolean) => {
      if (sessionRef.current !== session) return;
      console.log(
        takeover
          ? "📞 [call] Takeover — cutting Buddy off"
          : "📞 [call] Sentence boundary reached — Buddy yields"
      );
      releaseAiAudio();
      // Back to normal detection sensitivity for the child's turn.
      vadRef.current?.setStartConfirmMs(VAD_CONFIG.startConfirmMs);
      interruptPendingRef.current = false;
      setInterruptPending(false);
      interruptFirstDetectAtRef.current = 0;
      const alreadyPaused = interruptEndedAtRef.current > 0;
      interruptEndedAtRef.current = 0;
      // Keep recording the same interruption turn; only the floor changes.
      setPhaseBoth("recording");
      if (takeover) {
        void submitTurnRef.current?.(session);
      } else if (alreadyPaused) {
        // The child already finished talking while Buddy wrapped up, so no
        // further VAD endpoint will fire — schedule the submission here.
        scheduleEndpointSubmit(session);
      }
    },
    [releaseAiAudio, scheduleEndpointSubmit, setPhaseBoth]
  );

  /** rAF loop: pause Buddy at the next sentence end once an interruption
   *  is queued; hard-cut on takeover. No-op behavior without interruption. */
  const watchBoundaries = useCallback(
    (audioEl: HTMLAudioElement, session: number) => {
      const tick = () => {
        if (sessionRef.current !== session || aiAudioRef.current !== audioEl) {
          boundaryRafRef.current = null;
          return;
        }
        if (interruptPendingRef.current) {
          const firstAt = interruptFirstDetectAtRef.current;
          if (firstAt > 0 && Date.now() - firstAt >= TAKEOVER_MS) {
            finishInterruption(session, true);
            return;
          }
          const bs = boundariesRef.current;
          const idx = nextBoundaryIndexRef.current;
          const nowMs = audioEl.currentTime * 1000;
          if (idx < bs.length && nowMs >= bs[idx]) {
            nextBoundaryIndexRef.current = idx + 1;
            finishInterruption(session, false);
            return;
          }
        } else {
          // No interruption queued: just keep the boundary index in sync so a
          // later interruption yields at the CURRENT sentence's end.
          const bs = boundariesRef.current;
          const nowMs = audioEl.currentTime * 1000;
          let idx = nextBoundaryIndexRef.current;
          while (idx < bs.length - 1 && nowMs >= bs[idx]) idx++;
          nextBoundaryIndexRef.current = idx;
        }
        boundaryRafRef.current = requestAnimationFrame(tick);
      };
      stopBoundaryWatch();
      boundaryRafRef.current = requestAnimationFrame(tick);
    },
    [finishInterruption, stopBoundaryWatch]
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

          // Estimate where each sentence of the reply ends so an
          // interruption pauses Buddy at a sentence boundary instead of
          // cutting him off mid-word. Recomputed once metadata (duration)
          // is available; falls back to a single end boundary until then.
          const loadBoundaries = () => {
            const durationMs = audioEl.duration * 1000;
            boundariesRef.current =
              Number.isFinite(durationMs) && durationMs > 0
                ? estimateSentenceBoundaries(aiText, durationMs)
                : [Number.POSITIVE_INFINITY];
            nextBoundaryIndexRef.current = 0;
          };
          boundariesRef.current = [Number.POSITIVE_INFINITY];
          nextBoundaryIndexRef.current = 0;
          audioEl.onloadedmetadata = loadBoundaries;
          if (audioEl.readyState >= 1) loadBoundaries();

          const resumeListening = () => {
            if (sessionRef.current !== session) return;
            if (aiAudioRef.current === audioEl) aiAudioRef.current = null;
            stopBoundaryWatch();
            // Back to normal detection sensitivity. A short noise made while
            // Buddy spoke never committed, so there is nothing to drop.
            vadRef.current?.setStartConfirmMs(VAD_CONFIG.startConfirmMs);
            if (interruptPendingRef.current) {
              // The reply ended (last boundary) with an interruption queued:
              // hand the floor to the child; the endpoint flow submits it.
              interruptPendingRef.current = false;
              setInterruptPending(false);
              interruptFirstDetectAtRef.current = 0;
              const alreadyPaused = interruptEndedAtRef.current > 0;
              interruptEndedAtRef.current = 0;
              setPhaseBoth("recording");
              if (alreadyPaused) {
                scheduleEndpointSubmit(session);
              }
              return;
            }
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
            // While Buddy talks, only sustained speech may interrupt:
            // raise the VAD's confirm window for this phase (restored in
            // resumeListening / finishInterruption).
            vadRef.current?.setStartConfirmMs(INTERRUPT_DEBOUNCE_MS);
            watchBoundaries(audioEl, session);
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
    [
      accent,
      voice,
      setPhaseBoth,
      stopTurnRecorder,
      stopBoundaryWatch,
      scheduleEndpointSubmit,
      watchBoundaries,
    ]
  );
  useEffect(() => {
    submitTurnRef.current = submitTurn;
  }, [submitTurn]);

  // ── Speech detected while Buddy's reply is playing ──────────────────

  /**
   * Entry point for interruptions. The VAD only emits speech-start during
   * Buddy's reply after INTERRUPT_DEBOUNCE_MS of sustained speech (its
   * confirm window is raised for this phase), so reaching here already
   * means a genuine interruption: commit immediately, capture the child
   * (unannounced — Buddy keeps talking), and let the boundary watcher pick
   * the yield point.
   */
  const onSpeechDuringSpeaking = useCallback(
    (session: number) => {
      if (!interruptPendingRef.current) {
        interruptPendingRef.current = true;
        setInterruptPending(true);
        interruptFirstDetectAtRef.current = Date.now();
      }
      // New or resumed committed speech: keep capturing the same turn.
      interruptEndedAtRef.current = 0;
      startTurnRecording(session, { announce: false });
    },
    [startTurnRecording]
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
    clearInterruption();
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
          // Buddy is mid-reply: never cut him off mid-sentence. Debounce
          // noise, capture the child, yield at the next sentence boundary.
          onSpeechDuringSpeaking(session);
        }
      },
      onSpeechEnd: (reason) => {
        if (sessionRef.current !== session || mutedRef.current) return;
        if (phaseRef.current === "speaking") {
          if (interruptPendingRef.current) {
            // Committed interruption: child paused while Buddy wraps up.
            // finishInterruption will schedule the submission.
            interruptEndedAtRef.current = Date.now();
          }
          // No pending interruption: unreachable with the raised confirm
          // window (a confirmed start always commits) — the noise was never
          // recorded and Buddy keeps speaking unaffected.
          return;
        }
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
    stopTurnRecorder,
    clearEndpointTimer,
    clearInterruption,
    onSpeechDuringSpeaking,
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
      // Discard anything recorded so far — do NOT submit. A queued
      // interruption is dropped too: muted means the child isn't talking.
      clearInterruption();
      stopTurnRecorder();
      if (phaseRef.current === "recording") setPhaseBoth("listening");
    } else {
      vad?.setEnabled(true);
      // Ignore the sound of tapping unmute.
      vad?.beginCooldown(150);
    }
  }, [setPhaseBoth, stopTurnRecorder, clearInterruption]);

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

        {/* Queued-interruption hint: fixed height so nothing shifts around. */}
        <div aria-live="polite" className="mt-3 flex h-7 items-center">
          {interruptPending && phase === "speaking" && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-400/15 px-3 py-1 text-xs font-medium text-blue-200">
              🎤 I&apos;ll answer after this sentence…
            </span>
          )}
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
