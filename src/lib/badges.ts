import type { Session } from "./messageStore";
import { computeStatsFromSessions, type ProgressStats } from "./stats";

export interface BadgeDef {
  id: string;
  emoji: string;
  name: string;
  description: string;
  /** Current value of the metric this badge tracks. */
  metric: (stats: ProgressStats) => number;
  target: number;
  /** Kid-friendly label for the metric value, e.g. "3 / 5 chats". */
  progressLabel: (value: number, target: number) => string;
}

export const BADGES: BadgeDef[] = [
  {
    id: "first-chat",
    emoji: "🎯",
    name: "First Hello",
    description: "Finish your first conversation",
    metric: (s) => s.totalSessions,
    target: 1,
    progressLabel: (v, t) => `${Math.min(v, t)} / ${t} chat`,
  },
  {
    id: "chats-5",
    emoji: "💬",
    name: "Getting Talkative",
    description: "Have 5 conversations",
    metric: (s) => s.totalSessions,
    target: 5,
    progressLabel: (v, t) => `${Math.min(v, t)} / ${t} chats`,
  },
  {
    id: "chats-20",
    emoji: "🌟",
    name: "Conversation Star",
    description: "Have 20 conversations",
    metric: (s) => s.totalSessions,
    target: 20,
    progressLabel: (v, t) => `${Math.min(v, t)} / ${t} chats`,
  },
  {
    id: "streak-3",
    emoji: "🔥",
    name: "Warming Up",
    description: "Practice 3 days in a row",
    metric: (s) => s.currentStreak,
    target: 3,
    progressLabel: (v, t) => `${Math.min(v, t)} / ${t} days`,
  },
  {
    id: "streak-7",
    emoji: "🚀",
    name: "Unstoppable",
    description: "Practice 7 days in a row",
    metric: (s) => s.currentStreak,
    target: 7,
    progressLabel: (v, t) => `${Math.min(v, t)} / ${t} days`,
  },
  {
    id: "streak-14",
    emoji: "👑",
    name: "English Royalty",
    description: "Practice 14 days in a row",
    metric: (s) => s.currentStreak,
    target: 14,
    progressLabel: (v, t) => `${Math.min(v, t)} / ${t} days`,
  },
  {
    id: "messages-50",
    emoji: "🗣️",
    name: "Speaker",
    description: "Exchange 50 messages",
    metric: (s) => s.totalMessages,
    target: 50,
    progressLabel: (v, t) => `${Math.min(v, t)} / ${t} messages`,
  },
  {
    id: "words-5",
    emoji: "📚",
    name: "Word Collector",
    description: "Learn 5 new words",
    metric: (s) => s.totalWords,
    target: 5,
    progressLabel: (v, t) => `${Math.min(v, t)} / ${t} words`,
  },
  {
    id: "words-25",
    emoji: "🦉",
    name: "Vocabulary Master",
    description: "Learn 25 new words",
    metric: (s) => s.totalWords,
    target: 25,
    progressLabel: (v, t) => `${Math.min(v, t)} / ${t} words`,
  },
  {
    id: "corrections-10",
    emoji: "✏️",
    name: "Sharper Every Day",
    description: "Review 10 gentle fixes",
    metric: (s) => s.totalCorrections,
    target: 10,
    progressLabel: (v, t) => `${Math.min(v, t)} / ${t} fixes`,
  },
  {
    id: "minutes-60",
    emoji: "⏰",
    name: "Practice Hour",
    description: "Practice for 60 minutes in total",
    metric: (s) => s.totalMinutes,
    target: 60,
    progressLabel: (v, t) => `${Math.min(v, t)} / ${t} min`,
  },
  {
    id: "days-7",
    emoji: "📅",
    name: "Weekly Hero",
    description: "Practice on 7 different days",
    metric: (s) => s.totalPracticeDays,
    target: 7,
    progressLabel: (v, t) => `${Math.min(v, t)} / ${t} days`,
  },
];

export interface BadgeProgress {
  def: BadgeDef;
  value: number;
  unlocked: boolean;
  /** 0 to 1 completion ratio. */
  progress: number;
  label: string;
}

/**
 * Evaluate every badge against the stored conversation history. All metrics
 * are derived from sessions — nothing is counted incrementally, so progress
 * can never drift from the real data.
 */
export function checkBadges(sessions: Session[]): BadgeProgress[] {
  const stats = computeStatsFromSessions(sessions);
  return BADGES.map((def) => {
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
