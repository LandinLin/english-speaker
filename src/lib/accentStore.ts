"use client";

/**
 * Teacher voice preference, per user ("english-buddy:accent:<uid>").
 * Only the { accent, gender } ids are sent with /api/conversation and
 * /api/tts requests; the server maps them to Edge TTS voices.
 */

import { useSyncExternalStore } from "react";
import { scopedKey } from "./userScope";

export type AccentId = "us" | "uk" | "au" | "in";
export type GenderId = "female" | "male";

export interface AccentPreference {
  accent: AccentId;
  gender: GenderId;
}

export interface AccentDef {
  id: AccentId;
  label: string;
  emoji: string;
  /** Short kid-friendly description shown in the picker. */
  hint: string;
}

export interface GenderDef {
  id: GenderId;
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

export const GENDERS: GenderDef[] = [
  { id: "female", label: "Female", emoji: "👧", glyph: "♀" },
  { id: "male", label: "Male", emoji: "👦", glyph: "♂" },
];

export const DEFAULT_ACCENT_PREFERENCE: AccentPreference = {
  accent: "us",
  gender: "female",
};

const ACCENT_BASE = "english-buddy:accent";

function isAccentId(value: unknown): value is AccentId {
  return ACCENTS.some((accent) => accent.id === value);
}

function isGenderId(value: unknown): value is GenderId {
  return value === "female" || value === "male";
}

function storageKey(): string {
  return scopedKey(ACCENT_BASE);
}

/**
 * Accepts the current object shape and the legacy plain-string value
 * ("us" | "uk" | …) saved by the previous accent-only version.
 */
function readStored(): AccentPreference {
  if (typeof window === "undefined") return DEFAULT_ACCENT_PREFERENCE;
  try {
    const raw = window.localStorage.getItem(storageKey());
    if (!raw) return DEFAULT_ACCENT_PREFERENCE;
    if (isAccentId(raw)) {
      return { accent: raw, gender: "female" };
    }
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const p = parsed as Record<string, unknown>;
      return {
        accent: isAccentId(p.accent)
          ? p.accent
          : DEFAULT_ACCENT_PREFERENCE.accent,
        gender: isGenderId(p.gender)
          ? p.gender
          : DEFAULT_ACCENT_PREFERENCE.gender,
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
    gender: isGenderId(pref.gender) ? pref.gender : current.gender,
  };
  if (next.accent === current.accent && next.gender === current.gender) return;
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
  if (next.accent !== current.accent || next.gender !== current.gender) {
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
