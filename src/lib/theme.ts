/**
 * Background theme store. The selected theme id is written to
 * localStorage ("english-buddy:theme") and applied as a data-theme
 * attribute on <html>; globals.css maps each theme to background /
 * text CSS variables. An inline script in the root layout re-applies
 * the stored theme before first paint to avoid a flash.
 */

import { useSyncExternalStore } from "react";

export type ThemeId = "blue" | "white" | "green" | "pink" | "orange" | "night";

export interface ThemeDef {
  id: ThemeId;
  label: string;
  emoji: string;
  /** CSS background used by the picker swatch (mirrors the real theme). */
  swatch: string;
  /** Card color inside the picker's mini preview (mirrors the real card). */
  cardSwatch: string;
}

export const THEMES: ThemeDef[] = [
  {
    id: "blue",
    label: "Sunny Blue",
    emoji: "☀️",
    swatch: "linear-gradient(180deg,#eff6ff,#f5f3ff)",
    cardSwatch: "#ffffff",
  },
  {
    id: "white",
    label: "Snow White",
    emoji: "❄️",
    swatch: "#ffffff",
    cardSwatch: "#f9fafb",
  },
  {
    id: "green",
    label: "Fresh Green",
    emoji: "🌿",
    swatch: "linear-gradient(180deg,#ecfdf5,#d1fae5)",
    cardSwatch: "#ffffff",
  },
  {
    id: "pink",
    label: "Bubblegum Pink",
    emoji: "🍬",
    swatch: "linear-gradient(180deg,#fdf2f8,#fce7f3)",
    cardSwatch: "#ffffff",
  },
  {
    id: "orange",
    label: "Juicy Orange",
    emoji: "🍊",
    swatch: "linear-gradient(180deg,#fff7ed,#ffedd5)",
    cardSwatch: "#ffffff",
  },
  {
    id: "night",
    label: "Night Black",
    emoji: "🌙",
    swatch: "linear-gradient(180deg,#0f172a,#1e293b)",
    cardSwatch: "#374151",
  },
];

const DEFAULT_THEME: ThemeId = "blue";
const STORAGE_KEY = "english-buddy:theme";

function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((theme) => theme.id === value);
}

function readStoredTheme(): ThemeId {
  if (typeof window === "undefined") return DEFAULT_THEME;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isThemeId(raw) ? raw : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

let current: ThemeId = DEFAULT_THEME;
if (typeof window !== "undefined") {
  current = readStoredTheme();
  document.documentElement.dataset.theme = current;
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getTheme(): ThemeId {
  return current;
}

export function setTheme(id: ThemeId): void {
  if (!isThemeId(id) || id === current) return;
  current = id;
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Storage unavailable — theme still applies for this session.
  }
  document.documentElement.dataset.theme = id;
  listeners.forEach((listener) => listener());
}

export function useTheme(): ThemeId {
  return useSyncExternalStore(subscribe, getTheme, () => DEFAULT_THEME);
}
