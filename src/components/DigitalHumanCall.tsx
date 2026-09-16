"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createAgentManager,
  AgentActivityState,
  ConnectionState,
  StreamingState,
  type AgentManager,
} from "@d-id/client-sdk";

const CLIENT_KEY = process.env.NEXT_PUBLIC_DID_CLIENT_KEY ?? "";
const AGENT_ID = process.env.NEXT_PUBLIC_DID_AGENT_ID ?? "";

const TEST_LINE = "Hello! How are you today?";

interface DigitalHumanCallProps {
  open: boolean;
  onClose: () => void;
}

type BusyAction = "connect" | "speak" | "disconnect" | null;

export default function DigitalHumanCall({
  open,
  onClose,
}: DigitalHumanCallProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const managerRef = useRef<AgentManager | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const micStreamRef = useRef<MediaStream | null>(null);
  const historyRef = useRef<{ role: "user" | "assistant"; content: string }[]>(
    []
  );
  // Mirrors isConnected for use inside stable async callbacks (no stale state).
  const isConnectedRef = useRef(false);

  const [connection, setConnection] = useState<ConnectionState>(
    ConnectionState.New
  );
  const [videoState, setVideoState] = useState<StreamingState | null>(null);
  const [activity, setActivity] = useState<AgentActivityState | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [listening, setListening] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [caption, setCaption] = useState<{
    user: string;
    buddy: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const configured = Boolean(CLIENT_KEY && AGENT_ID);
  // WebRTC avatars (V2/V3) reach "completed"; LiveKit avatars (V4) reach "connected".
  // Both mean the stream is live and ready for speak().
  const isConnected =
    connection === ConnectionState.Connected ||
    connection === ConnectionState.Completed;
  // LiveKit/Expressive avatars stream video continuously, so StreamingState
  // sticks at "START"; the activity callback is the real speech signal.
  // Fall back to videoState for WebRTC avatars that don't report activity.
  const isTalking =
    activity !== null
      ? activity === AgentActivityState.Talking
      : videoState === StreamingState.Start;

  // Lazily create the agent manager the first time Start Call is pressed.
  const ensureManager = useCallback(async (): Promise<AgentManager> => {
    if (managerRef.current) return managerRef.current;

    const manager = await createAgentManager(AGENT_ID, {
      auth: { type: "key", clientKey: CLIENT_KEY },
      enableAnalytics: false,
      callbacks: {
        // REQUIRED by the SDK: bind the WebRTC stream to the <video> tag.
        onSrcObjectReady: (srcObject: MediaStream) => {
          const video = videoRef.current;
          if (!video) return;
          video.srcObject = srcObject;
          void video.play().catch((err) => {
            // Autoplay policies can block audio until a user gesture;
            // the Start/Speak buttons count as gestures on this overlay.
            console.warn("📹 [digital-human] video.play() blocked:", err);
          });
        },
        onVideoStateChange: (state: StreamingState) => {
          console.log("📹 [digital-human] video state:", state);
          setVideoState(state);
        },
        onAgentActivityStateChange: (state: AgentActivityState) => {
          console.log("📹 [digital-human] agent activity:", state);
          setActivity(state);
        },
        onConnectionStateChange: (state: ConnectionState, reason?: string) => {
          console.log(
            "📹 [digital-human] connection state:",
            state,
            reason ?? ""
          );
          setConnection(state);
          isConnectedRef.current =
            state === ConnectionState.Connected ||
            state === ConnectionState.Completed;
          if (
            state === ConnectionState.Fail ||
            state === ConnectionState.Closed
          ) {
            setBusy(null);
          }
        },
        onError: (err: Error) => {
          console.error("📹 [digital-human] SDK error:", err);
          setError(err.message || "Something went wrong with the video call.");
          setBusy(null);
        },
      },
    });

    managerRef.current = manager;
    return manager;
  }, []);

  const handleStart = useCallback(async () => {
    if (!configured) return;
    setError(null);
    setBusy("connect");
    try {
      const manager = await ensureManager();
      await manager.connect();
    } catch (err) {
      console.error("📹 [digital-human] connect failed:", err);
      setError(
        err instanceof Error ? err.message : "Could not start the video call."
      );
    } finally {
      setBusy(null);
    }
  }, [configured, ensureManager]);

  const handleSpeak = useCallback(async () => {
    const manager = managerRef.current;
    if (!manager || !isConnected) return;
    setError(null);
    setBusy("speak");
    try {
      await manager.speak({ type: "text", input: TEST_LINE });
    } catch (err) {
      console.error("📹 [digital-human] speak failed:", err);
      setError(
        err instanceof Error ? err.message : "The avatar could not speak."
      );
    } finally {
      setBusy(null);
    }
  }, [isConnected]);

  const handleEnd = useCallback(async () => {
    const manager = managerRef.current;
    if (!manager) return;
    recorderRef.current?.stop();
    recorderRef.current = null;
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    micStreamRef.current = null;
    setListening(false);
    setBusy("disconnect");
    try {
      await manager.disconnect();
    } catch (err) {
      console.error("📹 [digital-human] disconnect failed:", err);
    } finally {
      if (videoRef.current) videoRef.current.srcObject = null;
      setVideoState(null);
      setActivity(null);
      setBusy(null);
    }
  }, []);

  // Mic recording → existing STT → LLM tutor pipeline → Buddy speaks the reply.
  const submitRecording = useCallback(async () => {
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    micStreamRef.current = null;
    setListening(false);

    const blob = new Blob(chunksRef.current, {
      type: chunksRef.current[0]?.type || "audio/webm",
    });
    chunksRef.current = [];
    recorderRef.current = null;
    if (blob.size === 0) return;

    setThinking(true);
    setCaption(null);
    try {
      const formData = new FormData();
      formData.append("audio", new File([blob], "speech.webm", { type: blob.type }));
      formData.append("history", JSON.stringify(historyRef.current));

      const res = await fetch("/api/conversation", {
        method: "POST",
        body: formData,
      });
      const data = (await res.json()) as {
        transcript?: string;
        aiText?: string;
        error?: string;
      };
      if (!res.ok || data.error) {
        throw new Error(data.error || `Request failed (${res.status})`);
      }

      const transcript = data.transcript ?? "";
      const aiText = data.aiText ?? "";
      historyRef.current = [
        ...historyRef.current,
        { role: "user" as const, content: transcript },
        { role: "assistant" as const, content: aiText },
      ].slice(-6);
      setCaption({ user: transcript, buddy: aiText });

      const manager = managerRef.current;
      if (manager && aiText && isConnectedRef.current) {
        setBusy("speak");
        try {
          await manager.speak({ type: "text", input: aiText });
        } finally {
          setBusy(null);
        }
      }
    } catch (err) {
      console.error("📹 [digital-human] conversation failed:", err);
      setError(
        err instanceof Error ? err.message : "Buddy couldn't hear you. Try again!"
      );
    } finally {
      setThinking(false);
    }
  }, []);

  const handleToggleMic = useCallback(async () => {
    setError(null);
    if (listening) {
      recorderRef.current?.stop(); // onstop → submitRecording
      return;
    }
    if (!managerRef.current || !isConnectedRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      chunksRef.current = [];
      const mimeType = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : undefined;
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => void submitRecording();
      recorder.start();
      setListening(true);
    } catch (err) {
      console.error("📹 [digital-human] mic access failed:", err);
      setError("Please allow microphone access so Buddy can hear you.");
    }
  }, [listening, submitRecording]);

  // Unmount / overlay close: always tear down the WebRTC connection.
  useEffect(() => {
    if (!open) return;
    const video = videoRef;
    return () => {
      const manager = managerRef.current;
      if (manager) {
        void manager
          .disconnect()
          .catch((err) =>
            console.error("📹 [digital-human] cleanup error:", err)
          );
      }
      managerRef.current = null;
      recorderRef.current?.stop();
      recorderRef.current = null;
      micStreamRef.current?.getTracks().forEach((track) => track.stop());
      micStreamRef.current = null;
      isConnectedRef.current = false;
      if (video.current) video.current.srcObject = null;
      setConnection(ConnectionState.New);
      setVideoState(null);
      setActivity(null);
      setListening(false);
      setThinking(false);
      setCaption(null);
      setError(null);
    };
  }, [open]);

  if (!open) return null;

  const showStart =
    !isConnected && connection !== ConnectionState.Connecting;
  const disconnecting =
    busy === "disconnect" || connection === ConnectionState.Disconnecting;

  return (
    <div className="flex h-full flex-col bg-gradient-to-b from-gray-900 to-blue-950">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between px-4 pt-4 pb-3 text-white">
        <div className="flex items-center gap-2">
          <span className="text-xl">🧑‍🏫</span>
          <div>
            <h2 className="text-sm font-bold">Video Call with Buddy</h2>
            <p className="flex items-center gap-1.5 text-[11px] text-blue-200">
              <span
                className={`inline-block h-2 w-2 rounded-full ${
                  isConnected
                    ? "bg-green-400"
                    : connection === ConnectionState.Connecting
                      ? "animate-pulse bg-amber-400"
                      : "bg-gray-400"
                }`}
              />
              {isConnected
                ? isTalking
                  ? "Talking…"
                  : "Connected"
                : connection === ConnectionState.Connecting
                  ? "Connecting…"
                  : connection === ConnectionState.Fail
                    ? "Connection failed"
                    : "Not connected"}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close video call"
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-lg text-white transition-colors hover:bg-white/20"
        >
          ✕
        </button>
      </div>

      {/* Video stage */}
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 pb-3">
        <div className="relative aspect-video w-full max-w-2xl overflow-hidden rounded-3xl bg-black shadow-2xl ring-1 ring-white/10">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            className="h-full w-full object-cover"
          />

          {/* Placeholder / talking indicator */}
          {!isConnected && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/80">
              <span className="text-6xl">{busy === "connect" ? "⏳" : "🧑‍🏫"}</span>
              <p className="text-xs">
                {busy === "connect"
                  ? "Buddy is joining the call…"
                  : "Press Start Call to meet Buddy!"}
              </p>
            </div>
          )}
          {isConnected && (
            <div
              className={`absolute left-3 top-3 rounded-full px-2.5 py-1 text-[10px] font-bold text-white shadow transition-all ${
                isTalking
                  ? "bg-red-500"
                  : "bg-black/50 text-white/80"
              }`}
            >
              {isTalking ? "🔴 TALKING" : "💤 IDLE"}
            </div>
          )}
        </div>
      </div>

      {/* Status / error */}
      <div className="shrink-0 px-4 text-center">
        {error && (
          <p className="mx-auto mb-2 max-w-md rounded-xl bg-red-500/15 px-3 py-2 text-xs font-medium text-red-200">
            ⚠️ {error}
          </p>
        )}
        {!configured && (
          <p className="mx-auto mb-2 max-w-md rounded-xl bg-amber-400/15 px-3 py-2 text-xs font-medium text-amber-200">
            🔑 D-ID keys are missing. Set <span className="font-mono">NEXT_PUBLIC_DID_CLIENT_KEY</span>{" "}
            and <span className="font-mono">NEXT_PUBLIC_DID_AGENT_ID</span> in
            .env.local, then restart the dev server.
          </p>
        )}

        {/* Conversation captions */}
        {thinking && (
          <p className="mx-auto mb-2 max-w-md rounded-xl bg-white/10 px-3 py-2 text-xs font-medium text-blue-100">
            🤔 Buddy is thinking…
          </p>
        )}
        {!thinking && caption && (
          <div className="mx-auto mb-2 max-w-md space-y-1.5 text-left">
            {caption.user && (
              <p className="rounded-xl bg-white/10 px-3 py-2 text-xs text-blue-100">
                <span className="font-bold">🧒 You:</span> {caption.user}
              </p>
            )}
            {caption.buddy && (
              <p className="rounded-xl bg-blue-500/20 px-3 py-2 text-xs text-blue-50">
                <span className="font-bold">🧑‍🏫 Buddy:</span> {caption.buddy}
              </p>
            )}
          </div>
        )}
        {listening && (
          <p className="mx-auto mb-2 max-w-md animate-pulse rounded-xl bg-red-500/20 px-3 py-2 text-xs font-bold text-red-200">
            🎙️ Listening… tap Done when you finish!
          </p>
        )}
      </div>

      {/* Controls */}
      <div className="flex shrink-0 items-center justify-center gap-3 px-4 pb-3">
        {showStart && (
          <button
            type="button"
            onClick={handleStart}
            disabled={!configured || busy !== null}
            className="rounded-full bg-green-500 px-6 py-3 text-sm font-bold text-white shadow-lg transition-all hover:bg-green-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy === "connect" ? "Connecting…" : "📞 Start Call"}
          </button>
        )}

        {isConnected && (
          <>
            <button
              type="button"
              onClick={handleToggleMic}
              disabled={busy !== null || thinking}
              className={`rounded-full px-6 py-3 text-sm font-bold text-white shadow-lg transition-all disabled:cursor-not-allowed disabled:opacity-40 ${
                listening
                  ? "animate-pulse bg-red-500 hover:bg-red-600"
                  : "bg-purple-500 hover:bg-purple-600"
              }`}
            >
              {listening ? "⏹ Done" : "🎤 Talk"}
            </button>
            <button
              type="button"
              onClick={handleSpeak}
              disabled={busy !== null || listening || thinking}
              className="rounded-full bg-blue-500 px-6 py-3 text-sm font-bold text-white shadow-lg transition-all hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === "speak" ? "Speaking…" : "💬 Speak Text"}
            </button>
            <button
              type="button"
              onClick={handleEnd}
              disabled={disconnecting}
              className="rounded-full bg-red-500 px-6 py-3 text-sm font-bold text-white shadow-lg transition-all hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {disconnecting ? "Ending…" : "📴 End Call"}
            </button>
          </>
        )}
      </div>

      <p className="shrink-0 pb-3 text-center text-[10px] text-blue-300/60">
        Voice: your STT → LLM pipeline · video &amp; lip-sync by D-ID
      </p>
    </div>
  );
}
