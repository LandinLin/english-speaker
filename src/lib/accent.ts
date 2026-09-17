"use client";

/**
 * Teacher accent preference, per user ("english-buddy:accent:<uid>").
 * The id is sent with /api/conversation and /api/tts requests; the server
 * maps it to the matching Edge TTS voice.
 */

import { useSyncExternalStore } from "react";
import { scopedKey } from "./userScope";

export type AccentId = "us" | "uk" | "au" | "in";

export interface AccentDef {
  id: AccentId;
  label: string;
  emoji: string;
  /** Short kid-friendly description shown in the picker. */
  hint: string;
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

export const DEFAULT_ACCENT: AccentId = "us";
const ACCENT_BASE = "english-buddy:accent";

function isAccentId(value: unknown): value is AccentId {
  return ACCENTS.some((accent) => accent.id === value);
}

function storageKey(): string {
  return scopedKey(ACCENT_BASE);
}

function readStored(): AccentId {
  if (typeof window === "undefined") return DEFAULT_ACCENT;
  try {
    const raw = window.localStorage.getItem(storageKey());
    return isAccentId(raw) ? raw : DEFAULT_ACCENT;
  } catch {
    return DEFAULT_ACCENT;
  }
}

let current: AccentId = DEFAULT_ACCENT;
if (typeof window !== "undefined") current = readStored();

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAccent(): AccentId {
  return current;
}

export function setAccent(id: AccentId): void {
  if (!isAccentId(id) || id === current) return;
  current = id;
  try {
    window.localStorage.setItem(storageKey(), id);
  } catch {
    // Storage unavailable — preference applies for this session only.
  }
  listeners.forEach((listener) => listener());
}

/** Re-read the preference after login/logout (the per-user key changes). */
export function resetAccent(): void {
  const next = readStored();
  if (next !== current) {
    current = next;
    listeners.forEach((listener) => listener());
  }
}

export function useAccent(): AccentId {
  return useSyncExternalStore(subscribe, getAccent, () => DEFAULT_ACCENT);
}
