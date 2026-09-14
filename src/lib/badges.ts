import type { Session } from "./messageStore";
import {
  computeStatsFromSessions,
  type ProgressStats,
} from "./stats";

// ===========================================================================
// New badge system — badge definitions with categories + conditions
// ===========================================================================

export type BadgeCategory = "milestone" | "streak" | "skill" | "effort";

export interface Badge {
  id: string;
  name: string;
  emoji: string;
  description: string;
  category: BadgeCategory;
  /** Returns true when the stats satisfy this badge's unlock condition. */
  condition: (stats: LearningStats) => boolean;
  /** Kid-friendly progress label, e.g. "3 / 5 letters". */
  progressLabel: (stats: LearningStats) => string;
}

export interface LearningStats {
  totalLessons: number;
  totalMinutes: number;
  totalSentences: number;
  uniqueWordsLearned: number;
  lettersLearned: string[];
  currentStreak: number;
  longestStreak: number;
  perfectLessons: number;
}

// --- Badge definitions (18 badges across 4 categories) ---------------------

export const BADGES: Badge[] = [
  // Milestone
  {
    id: "first-lesson",
    name: "First Lesson",
    emoji: "🌟",
    description: "Finish your very first lesson",
    category: "milestone",
    condition: (s) => s.totalLessons >= 1,
    progressLabel: (s) => `${Math.min(s.totalLessons, 1)} / 1 lesson`,
  },
  {
    id: "first-word",
    name: "First Word",
    emoji: "🎤",
    description: "Learn your first new word",
    category: "milestone",
    condition: (s) => s.uniqueWordsLearned >= 1,
    progressLabel: (s) => `${Math.min(s.uniqueWordsLearned, 1)} / 1 word`,
  },
  {
    id: "perfect-lesson",
    name: "Perfect Lesson",
    emoji: "💎",
    description: "Finish a lesson with no mistakes",
    category: "milestone",
    condition: (s) => s.perfectLessons >= 1,
    progressLabel: (s) => `${Math.min(s.perfectLessons, 1)} / 1 perfect`,
  },
  {
    id: "lesson-5",
    name: "Lesson Star",
    emoji: "📚",
    description: "Complete 5 lessons",
    category: "milestone",
    condition: (s) => s.totalLessons >= 5,
    progressLabel: (s) => `${Math.min(s.totalLessons, 5)} / 5 lessons`,
  },

  // Streak
  {
    id: "streak-3",
    name: "Warming Up",
    emoji: "🔥",
    description: "Practice 3 days in a row",
    category: "streak",
    condition: (s) => s.currentStreak >= 3,
    progressLabel: (s) => `${Math.min(s.currentStreak, 3)} / 3 days`,
  },
  {
    id: "streak-7",
    name: "On Fire",
    emoji: "🔥🔥",
    description: "Practice 7 days in a row",
    category: "streak",
    condition: (s) => s.currentStreak >= 7,
    progressLabel: (s) => `${Math.min(s.currentStreak, 7)} / 7 days`,
  },
  {
    id: "streak-30",
    name: "Unstoppable",
    emoji: "🏆",
    description: "Practice 30 days in a row",
    category: "streak",
    condition: (s) => s.currentStreak >= 30,
    progressLabel: (s) => `${Math.min(s.currentStreak, 30)} / 30 days`,
  },

  // Skill
  {
    id: "letter-explorer",
    name: "Letter Explorer",
    emoji: "🔤",
    description: "Learn 5 different letters",
    category: "skill",
    condition: (s) => s.lettersLearned.length >= 5,
    progressLabel: (s) => `${Math.min(s.lettersLearned.length, 5)} / 5 letters`,
  },
  {
    id: "abc-master",
    name: "ABC Master",
    emoji: "🎓",
    description: "Learn all 26 letters",
    category: "skill",
    condition: (s) => s.lettersLearned.length >= 26,
    progressLabel: (s) => `${Math.min(s.lettersLearned.length, 26)} / 26 letters`,
  },
  {
    id: "word-collector",
    name: "Word Collector",
    emoji: "📚",
    description: "Learn 50 new words",
    category: "skill",
    condition: (s) => s.uniqueWordsLearned >= 50,
    progressLabel: (s) => `${Math.min(s.uniqueWordsLearned, 50)} / 50 words`,
  },
  {
    id: "word-wizard",
    name: "Word Wizard",
    emoji: "🧙",
    description: "Learn 100 new words",
    category: "skill",
    condition: (s) => s.uniqueWordsLearned >= 100,
    progressLabel: (s) => `${Math.min(s.uniqueWordsLearned, 100)} / 100 words`,
  },
  {
    id: "sentences-50",
    name: "Sentence Builder",
    emoji: "💬",
    description: "Say 50 sentences",
    category: "skill",
    condition: (s) => s.totalSentences >= 50,
    progressLabel: (s) => `${Math.min(s.totalSentences, 50)} / 50 sentences`,
  },

  // Effort
  {
    id: "minutes-10",
    name: "Getting Started",
    emoji: "💪",
    description: "Practice for 10 minutes",
    category: "effort",
    condition: (s) => s.totalMinutes >= 10,
    progressLabel: (s) => `${Math.min(s.totalMinutes, 10)} / 10 min`,
  },
  {
    id: "minutes-60",
    name: "1 Hour Hero",
    emoji: "⏰",
    description: "Practice for 60 minutes",
    category: "effort",
    condition: (s) => s.totalMinutes >= 60,
    progressLabel: (s) => `${Math.min(s.totalMinutes, 60)} / 60 min`,
  },
  {
    id: "chatterbox",
    name: "Chatterbox",
    emoji: "🗣️",
    description: "Say 100 sentences",
    category: "effort",
    condition: (s) => s.totalSentences >= 100,
    progressLabel: (s) => `${Math.min(s.totalSentences, 100)} / 100 sentences`,
  },
  {
    id: "lessons-10",
    name: "Lesson Champion",
    emoji: "🥇",
    description: "Complete 10 lessons",
    category: "effort",
    condition: (s) => s.totalLessons >= 10,
    progressLabel: (s) => `${Math.min(s.totalLessons, 10)} / 10 lessons`,
  },
  {
    id: "words-25",
    name: "Vocabulary Master",
    emoji: "🦉",
    description: "Learn 25 new words",
    category: "skill",
    condition: (s) => s.uniqueWordsLearned >= 25,
    progressLabel: (s) => `${Math.min(s.uniqueWordsLearned, 25)} / 25 words`,
  },
  {
    id: "streak-14",
    name: "English Royalty",
    emoji: "👑",
    description: "Practice 14 days in a row",
    category: "streak",
    condition: (s) => s.currentStreak >= 14,
    progressLabel: (s) => `${Math.min(s.currentStreak, 14)} / 14 days`,
  },
];

/**
 * Check which badges are newly earned given the current stats and the set
 * of badge IDs the child already has.
 */
export function checkNewBadges(
  stats: LearningStats,
  earnedBadgeIds: string[]
): Badge[] {
  const earnedSet = new Set(earnedBadgeIds);
  return BADGES.filter(
    (badge) => !earnedSet.has(badge.id) && badge.condition(stats)
  );
}

/**
 * Build LearningStats from localStorage conversation sessions.
 * Also merges lesson-specific data from the badge storage.
 */
export function calculateStats(sessions: Session[]): LearningStats {
  const ps: ProgressStats = computeStatsFromSessions(sessions);

  // Derive letters learned from newWord fields (words starting with a letter)
  const letterSet = new Set<string>();
  for (const w of ps.words) {
    const ch = w.word[0]?.toUpperCase();
    if (ch && /[A-Z]/.test(ch)) letterSet.add(ch);
  }

  // Count user messages as "sentences"
  const totalSentences = sessions.reduce(
    (sum, s) => sum + s.messages.filter((m) => m.role === "user").length,
    0
  );

  // Read lesson stats from badge storage (safe on server: returns defaults)
  let totalLessons = 0;
  let perfectLessons = 0;
  if (typeof window !== "undefined") {
    try {
      const raw = localStorage.getItem("english-buddy-stats");
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<LearningStats>;
        totalLessons = parsed.totalLessons ?? 0;
        perfectLessons = parsed.perfectLessons ?? 0;
      }
    } catch {
      // ignore
    }
  }

  return {
    totalLessons,
    totalMinutes: ps.totalMinutes,
    totalSentences,
    uniqueWordsLearned: ps.totalWords,
    lettersLearned: [...letterSet].sort(),
    currentStreak: ps.currentStreak,
    longestStreak: ps.longestStreak,
    perfectLessons,
  };
}

// ===========================================================================
// Backwards-compatible exports for the existing dashboard
// ===========================================================================

/** Old badge shape kept for the dashboard. */
export interface BadgeDef {
  id: string;
  emoji: string;
  name: string;
  description: string;
  metric: (stats: ProgressStats) => number;
  target: number;
  progressLabel: (value: number, target: number) => string;
}

/** Map new badges into the old BadgeDef shape for the dashboard. */
const LEGACY_BADGES: BadgeDef[] = BADGES.map((b) => {
  // We need a metric/target pair from the new condition + progressLabel.
  // Since the new system uses LearningStats, we map to the closest ProgressStats field.
  return {
    id: b.id,
    emoji: b.emoji,
    name: b.name,
    description: b.description,
    metric: (ps: ProgressStats) => {
      // Best-effort mapping from ProgressStats to each badge's numeric metric
      switch (b.id) {
        case "first-lesson":
        case "lesson-5":
        case "lessons-10":
          return ps.totalSessions;
        case "first-word":
        case "word-collector":
        case "word-wizard":
        case "words-25":
          return ps.totalWords;
        case "streak-3":
        case "streak-7":
        case "streak-30":
        case "streak-14":
          return ps.currentStreak;
        case "minutes-10":
        case "minutes-60":
          return ps.totalMinutes;
        case "sentences-50":
        case "chatterbox":
          return ps.totalMessages;
        case "letter-explorer":
        case "abc-master": {
          const letters = new Set<string>();
          for (const w of ps.words) {
            const ch = w.word[0]?.toUpperCase();
            if (ch && /[A-Z]/.test(ch)) letters.add(ch);
          }
          return letters.size;
        }
        case "perfect-lesson":
          return 0; // Not trackable from ProgressStats alone
        default:
          return 0;
      }
    },
    target: (() => {
      switch (b.id) {
        case "first-lesson": return 1;
        case "lesson-5": return 5;
        case "lessons-10": return 10;
        case "first-word": return 1;
        case "word-collector": return 50;
        case "word-wizard": return 100;
        case "words-25": return 25;
        case "streak-3": return 3;
        case "streak-7": return 7;
        case "streak-14": return 14;
        case "streak-30": return 30;
        case "minutes-10": return 10;
        case "minutes-60": return 60;
        case "sentences-50": return 50;
        case "chatterbox": return 100;
        case "letter-explorer": return 5;
        case "abc-master": return 26;
        case "perfect-lesson": return 1;
        default: return 1;
      }
    })(),
    progressLabel: (v: number, t: number) => `${Math.min(v, t)} / ${t}`,
  };
});

export interface BadgeProgress {
  def: BadgeDef;
  value: number;
  unlocked: boolean;
  progress: number;
  label: string;
}

export function checkBadges(sessions: Session[]): BadgeProgress[] {
  const stats = computeStatsFromSessions(sessions);
  return LEGACY_BADGES.map((def) => {
    const value = def.metric(stats);
    const unlocked = value >= def.target;
    return {
      def,
      value,
      unlocked,
      progress: Math.max(0, Math.min(1, value / def.target)),
      label: def.progressLabel(value, def.target),
    };
  });
}

export function countEarnedBadges(sessions: Session[]): number {
  return checkBadges(sessions).filter((b) => b.unlocked).length;
}
