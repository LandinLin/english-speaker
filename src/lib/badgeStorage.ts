import type { LearningStats } from "./badges";
import { scopedKey } from "./userScope";

const BADGES_BASE = "english-buddy-badges";
const STATS_BASE = "english-buddy-stats";

function badgesKey(): string {
  return scopedKey(BADGES_BASE);
}
function statsKey(): string {
  return scopedKey(STATS_BASE);
}

const DEFAULT_STATS: LearningStats = {
  totalLessons: 0,
  totalMinutes: 0,
  totalSentences: 0,
  uniqueWordsLearned: 0,
  lettersLearned: [],
  currentStreak: 0,
  longestStreak: 0,
  perfectLessons: 0,
};

// --- Badge IDs ---

export function getEarnedBadges(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(badgesKey());
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveEarnedBadges(ids: string[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(badgesKey(), JSON.stringify(ids));
  } catch {
    // ignore
  }
}

export function addEarnedBadge(id: string): string[] {
  const current = getEarnedBadges();
  if (current.includes(id)) return current;
  const updated = [...current, id];
  saveEarnedBadges(updated);
  return updated;
}

// --- Stats ---

export function getStats(): LearningStats {
  if (typeof window === "undefined") return { ...DEFAULT_STATS };
  try {
    const raw = localStorage.getItem(statsKey());
    if (!raw) return { ...DEFAULT_STATS };
    const parsed = JSON.parse(raw) as Partial<LearningStats>;
    return { ...DEFAULT_STATS, ...parsed };
  } catch {
    return { ...DEFAULT_STATS };
  }
}

export function saveStats(stats: LearningStats): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(statsKey(), JSON.stringify(stats));
  } catch {
    // ignore
  }
}

// --- Testing helpers ---

export function resetBadgesAndStats(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(badgesKey());
  localStorage.removeItem(statsKey());
}

/** Force-unlock a badge by ID — for testing. */
export function forceUnlockBadge(id: string): void {
  addEarnedBadge(id);
}
