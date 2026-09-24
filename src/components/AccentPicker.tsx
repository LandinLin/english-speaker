"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ACCENTS,
  VOICE_TYPES,
  getAccentPreference,
  setAccentPreference,
  useAccent,
  type AccentId,
  type VoiceTypeId,
} from "@/lib/accentStore";
import { playClip, stopPlayback, usePlayingMessageId } from "@/lib/audioPlayer";

const PREVIEW_ID = "accent-preview";
const PREVIEW_TEXT = "Hi! I'm your English teacher. Let's practice together!";

/** Fetch + play the sample phrase in a specific voice. */
async function previewVoice(
  accent: AccentId,
  voice: VoiceTypeId
): Promise<void> {
  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: PREVIEW_TEXT, accent, voice }),
    });
    const data: { audioBase64?: string; error?: string } = await res.json();
    if (!res.ok || !data.audioBase64) {
      throw new Error(data.error || `TTS failed (${res.status})`);
    }
    playClip(PREVIEW_ID, `data:audio/mpeg;base64,${data.audioBase64}`);
  } catch (err) {
    console.error("🔊 [accent] Voice preview failed:", err);
  }
}

/**
 * Flag grid + voice-type selector + preview button. Shared by the full
 * settings card and the compact header dropdown.
 */
function VoiceControls({
  autoPreview,
}: {
  autoPreview: boolean;
}) {
  const { accent, voice } = useAccent();
  const playingId = usePlayingMessageId();
  const [busy, setBusy] = useState(false);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    };
  }, []);

  const playPreview = useCallback((a: AccentId, v: VoiceTypeId) => {
    setBusy(true);
    void previewVoice(a, v).finally(() => setBusy(false));
  }, []);

  // Tapping a flag/voice type auto-plays a short sample in the new voice. A
  // short debounce collapses rapid taps into a single preview.
  const schedulePreview = useCallback(
    (a: AccentId, v: VoiceTypeId) => {
      if (!autoPreview) return;
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
      previewTimerRef.current = setTimeout(() => {
        stopPlayback();
        playPreview(a, v);
      }, 300);
    },
    [autoPreview, playPreview]
  );

  const selectAccent = (id: AccentId) => {
    setAccentPreference({ accent: id });
    schedulePreview(id, getAccentPreference().voice);
  };

  const selectVoice = (id: VoiceTypeId) => {
    setAccentPreference({ voice: id });
    schedulePreview(getAccentPreference().accent, id);
  };

  const isPlaying = playingId === PREVIEW_ID;

  return (
    <div className="space-y-3">
      {/* Accent flags */}
      <div
        role="group"
        aria-label="Choose teacher accent"
        className="grid grid-cols-2 gap-1.5"
      >
        {ACCENTS.map((a) => {
          const selected = a.id === accent;
          return (
            <button
              key={a.id}
              type="button"
              aria-pressed={selected}
              onClick={() => selectAccent(a.id)}
              className={`flex items-center gap-2 rounded-xl px-2.5 py-2 text-left transition-colors ${
                selected ? "bg-blue-50 ring-1 ring-blue-200" : "hover:bg-gray-50"
              }`}
            >
              <span className="text-lg leading-none">{a.emoji}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-bold leading-tight text-gray-800">
                  {a.label}
                </span>
                <span className="block truncate text-[10px] text-gray-400">
                  {a.hint}
                </span>
              </span>
              {selected && (
                <span className="text-xs font-bold text-blue-500">✓</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Man / Woman / Boy / Girl */}
      <div
        role="group"
        aria-label="Choose teacher voice type"
        className="grid grid-cols-4 gap-1.5"
      >
        {VOICE_TYPES.map((v) => {
          const selected = v.id === voice;
          return (
            <button
              key={v.id}
              type="button"
              aria-pressed={selected}
              onClick={() => selectVoice(v.id)}
              className={`flex flex-col items-center gap-0.5 rounded-xl px-1 py-1.5 transition-colors ${
                selected
                  ? "bg-blue-50 ring-1 ring-blue-200"
                  : "hover:bg-gray-50"
              }`}
            >
              <span className="text-lg leading-none">{v.emoji}</span>
              <span
                className={`text-[10px] font-bold leading-tight ${
                  selected ? "text-blue-600" : "text-gray-500"
                }`}
              >
                {v.label}
              </span>
            </button>
          );
        })}
      </div>

      {/* Preview */}
      <button
        type="button"
        onClick={() => {
          stopPlayback();
          playPreview(accent, voice);
        }}
        className="flex w-full items-center justify-center gap-1.5 rounded-full bg-blue-500 px-3 py-2 text-xs font-bold text-white shadow-sm transition-colors hover:bg-blue-600"
      >
        {busy || isPlaying ? "🔊 Playing…" : "🔊 Preview voice"}
      </button>
    </div>
  );
}

/**
 * Teacher voice picker.
 * - compact (headers): flag + voice-type glyph pill opening a dropdown.
 * - full (Me settings): card with flag grid, 4 voice types and preview.
 */
export default function AccentPicker({
  compact = false,
}: {
  compact?: boolean;
}) {
  const { accent, voice } = useAccent();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handleDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleDown);
    return () => document.removeEventListener("mousedown", handleDown);
  }, [open]);

  const activeAccent = ACCENTS.find((a) => a.id === accent) ?? ACCENTS[0];
  const activeVoice =
    VOICE_TYPES.find((v) => v.id === voice) ?? VOICE_TYPES[3];

  if (!compact) {
    return (
      <section className="mx-auto mt-7 w-full max-w-md px-4">
        <h2 className="text-on-bg mb-2.5 px-1 text-sm font-medium opacity-80">
          🗣️ Teacher voice
        </h2>
        <div className="rounded-3xl bg-white p-4 shadow-sm">
          <VoiceControls autoPreview />
        </div>
      </section>
    );
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Teacher voice: ${activeAccent.label} ${activeVoice.label}. Click to change.`}
        className="flex h-9 items-center gap-1 rounded-full bg-white px-3 text-sm font-semibold text-gray-600 shadow-sm transition-colors hover:bg-gray-50"
      >
        <span className="text-base leading-none">{activeAccent.emoji}</span>
        <span
          className="text-[13px] leading-none"
          aria-hidden
        >
          {activeVoice.glyph}
        </span>
        <span className="text-[10px] text-gray-400">▾</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Choose teacher voice"
          className="absolute right-0 z-30 mt-2 w-64 rounded-2xl border border-gray-100 bg-white p-3 shadow-xl"
        >
          <p className="pb-2 text-[10px] font-bold uppercase tracking-wide text-gray-400">
            🗣️ Teacher voice
          </p>
          <VoiceControls autoPreview />
        </div>
      )}
    </div>
  );
}
