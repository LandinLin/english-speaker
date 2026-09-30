"use client";

/**
 * Teacher voice preference, per user ("english-buddy:accent:<uid>").
 * Only the { accent, voice } ids are sent with /api/conversation and
 * /api/tts requests; the server maps them to Edge TTS voices.
 */

import { useSyncExternalStore } from "react";
import { scopedKey } from "./userScope";

export type AccentId = "us" | "uk" | "au" | "in";
export type VoiceTypeId = "male" | "female" | "boy" | "girl";

export interface AccentPreference {
  accent: AccentId;
  voice: VoiceTypeId;
}

export interface AccentDef {
  id: AccentId;
  label: string;
  emoji: string;
  /** Short kid-friendly description shown in the picker. */
  hint: string;
}

export interface VoiceTypeDef {
  id: VoiceTypeId;
  label: string;
  emoji: string;
  /** Compact single-glyph marker used in the header pill. */
  glyph: string;
}

export const ACCENTS: AccentDef[] = [
  {
    id: "us",
    label: "American",
    emoji: "🇺🇸",
    hint: "Friendly US voice",
  },
  {
    id: "uk",
    label: "British",
    emoji: "🇬🇧",
    hint: "Cheerful UK voice",
  },
  {
    id: "au",
    label: "Australian",
    emoji: "🇦🇺",
    hint: "Sunny Aussie voice",
  },
  {
    id: "in",
    label: "Indian",
    emoji: "🇮🇳",
    hint: "Warm Indian voice",
  },
];

export const VOICE_TYPES: VoiceTypeDef[] = [
  { id: "male", label: "Man", emoji: "👨", glyph: "👨" },
  { id: "female", label: "Woman", emoji: "👩", glyph: "👩" },
  { id: "boy", label: "Boy", emoji: "👦", glyph: "👦" },
  { id: "girl", label: "Girl", emoji: "👧", glyph: "👧" },
];

export const DEFAULT_ACCENT_PREFERENCE: AccentPreference = {
  accent: "us",
  voice: "girl",
};

const ACCENT_BASE = "english-buddy:accent";

function isAccentId(value: unknown): value is AccentId {
  return ACCENTS.some((accent) => accent.id === value);
}

function isVoiceType(value: unknown): value is VoiceTypeId {
  return value === "male" || value === "female" || value === "boy" || value === "girl";
}

/** Map the previous female/male preference onto the new voice types. */
function legacyVoice(value: unknown): VoiceTypeId | null {
  if (value === "female") return "girl"; // old default used child voices
  if (value === "male") return "male";
  return null;
}

function storageKey(): string {
  return scopedKey(ACCENT_BASE);
}

/**
 * Accepts the current object shape, the previous { accent, gender } shape,
 * and the original plain-string accent value.
 */
function readStored(): AccentPreference {
  if (typeof window === "undefined") return DEFAULT_ACCENT_PREFERENCE;
  try {
    const raw = window.localStorage.getItem(storageKey());
    if (!raw) return DEFAULT_ACCENT_PREFERENCE;
    if (isAccentId(raw)) {
      return { accent: raw, voice: "girl" };
    }
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const p = parsed as Record<string, unknown>;
      const migrated = legacyVoice(p.gender);
      return {
        accent: isAccentId(p.accent)
          ? p.accent
          : DEFAULT_ACCENT_PREFERENCE.accent,
        voice: isVoiceType(p.voice)
          ? p.voice
          : migrated ?? DEFAULT_ACCENT_PREFERENCE.voice,
      };
    }
  } catch {
    // Fall through to defaults.
  }
  return DEFAULT_ACCENT_PREFERENCE;
}

let current: AccentPreference = DEFAULT_ACCENT_PREFERENCE;
if (typeof window !== "undefined") current = readStored();

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAccentPreference(): AccentPreference {
  return current;
}

export function setAccentPreference(pref: Partial<AccentPreference>): void {
  const next: AccentPreference = {
    accent: isAccentId(pref.accent) ? pref.accent : current.accent,
    voice: isVoiceType(pref.voice) ? pref.voice : current.voice,
  };

  console.log("setAccentPreference", next);
  if (next.accent === current.accent && next.voice === current.voice) return;
  current = next;
  try {
    window.localStorage.setItem(storageKey(), JSON.stringify(next));
  } catch {
    // Storage unavailable — preference applies for this session only.
  }
  listeners.forEach((listener) => listener());
}

/** Re-read the preference after login/logout (the per-user key changes). */
export function resetAccentPreference(): void {
  const next = readStored();
  if (next.accent !== current.accent || next.voice !== current.voice) {
    current = next;
    listeners.forEach((listener) => listener());
  }
}

export function useAccent(): AccentPreference {
  return useSyncExternalStore(
    subscribe,
    getAccentPreference,
    () => DEFAULT_ACCENT_PREFERENCE
  );
}
