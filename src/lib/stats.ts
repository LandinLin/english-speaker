import type { ChatMessage, Session } from "./messageStore";
import { selectSessions } from "./messageStore";

// --- Estimation constants -------------------------------------------------
// We don't record raw mic duration, so practice time is derived from message
// timestamps: every spoken exchange counts for a baseline, plus real elapsed
// gaps between messages while the child is actively chatting (gaps above the
// active threshold are treated as breaks and not counted).
const BASELINE_SECONDS_PER_EXCHANGE = 20;
const ACTIVE_GAP_MS = 5 * 60 * 1000;
const MAX_SESSION_SECONDS = 45 * 60;
const CHART_DAYS = 30;

export interface DayPractice {
  dateKey: string; // YYYY-MM-DD (local time)
  label: string; // e.g. "9/10"
  weekday: string; // e.g. "Mon"
  minutes: number; // rounded to 1 decimal
  isToday: boolean;
}

export interface LearnedWord {
  word: string;
  meaning: string;
  firstLearnedAt: number;
  count: number;
}

export interface CorrectionCount {
  correction: string;
  count: number;
}

export interface ProgressStats {
  sessions: Session[];
  totalSessions: number;
  totalMessages: number;
  totalMinutes: number;
  totalPracticeDays: number;
  currentStreak: number;
  longestStreak: number;
  words: LearnedWord[];
  totalWords: number;
  corrections: CorrectionCount[];
  totalCorrections: number;
  daily: DayPractice[]; // last 30 days, oldest first
}

export function dayKey(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function isNoneLike(value: string | undefined): boolean {
  return !value || value.trim().toLowerCase() === "none";
}

/** Parse "happy - glad" / "happy: a good feeling" into word + meaning. */
function parseNewWord(raw: string): { word: string; meaning: string } | null {
  const text = raw.trim();
  if (!text || isNoneLike(text)) return null;
  const match = text.match(/^(.+?)\s*[-—–:]\s*(.+)$/);
  const word = (match ? match[1] : text).trim();
  const meaning = (match ? match[2] : "").trim();
  if (!word) return null;
  return { word, meaning };
}

function normalizeCorrection(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^you should say\s+/, "")
    .replace(/^say\s+/, "")
    .replace(/[.!?。！？]+$/g, "")
    .replace(/\s+/g, " ");
}

interface SecondsAccumulator {
  secondsByDay: Map<string, number>;
  total: number;
}

function accumulateSession(session: Session, acc: SecondsAccumulator): void {
  const messages = [...session.messages].sort((a, b) => a.createdAt - b.createdAt);
  let sessionSeconds = 0;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];

    if (message.role === "user") {
      sessionSeconds += BASELINE_SECONDS_PER_EXCHANGE;
      const key = dayKey(message.createdAt);
      acc.secondsByDay.set(
        key,
        (acc.secondsByDay.get(key) ?? 0) + BASELINE_SECONDS_PER_EXCHANGE
      );
    }

    if (i > 0) {
      const gap = message.createdAt - messages[i - 1].createdAt;
      if (gap > 0 && gap <= ACTIVE_GAP_MS) {
        const gapSeconds = gap / 1000;
        sessionSeconds += gapSeconds;
        const key = dayKey(messages[i - 1].createdAt);
        acc.secondsByDay.set(
          key,
          (acc.secondsByDay.get(key) ?? 0) + gapSeconds
        );
      }
    }
  }

  acc.total += Math.min(sessionSeconds, MAX_SESSION_SECONDS);
}

function calculateStreaks(practiceDays: Set<string>): {
  current: number;
  longest: number;
} {
  if (practiceDays.size === 0) return { current: 0, longest: 0 };
  const sorted = [...practiceDays].sort();

  // Longest run ever.
  let longest = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(`${sorted[i - 1]}T00:00:00`);
    const cur = new Date(`${sorted[i]}T00:00:00`);
    const diffDays = Math.round((cur.getTime() - prev.getTime()) / 86400000);
    run = diffDays === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }

  // Current run: today counts; if no practice today yet, yesterday keeps it.
  const todayKey = dayKey(Date.now());
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  let cursorKey = practiceDays.has(todayKey)
    ? todayKey
    : dayKey(yesterday.getTime());
  let current = 0;
  while (practiceDays.has(cursorKey)) {
    current++;
    const d = new Date(`${cursorKey}T00:00:00`);
    d.setDate(d.getDate() - 1);
    cursorKey = dayKey(d.getTime());
  }

  return { current, longest };
}

function buildDaily(secondsByDay: Map<string, number>): DayPractice[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const result: DayPractice[] = [];

  for (let i = CHART_DAYS - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = dayKey(d.getTime());
    result.push({
      dateKey: key,
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      weekday: d.toLocaleDateString([], { weekday: "short" }),
      minutes: Math.round((secondsByDay.get(key) ?? 0) / 60 * 10) / 10,
      isToday: i === 0,
    });
  }
  return result;
}

export function computeStatsFromSessions(sessions: Session[]): ProgressStats {
  const ordered = [...sessions].sort((a, b) => a.startedAt - b.startedAt);
  const acc: SecondsAccumulator = {
    secondsByDay: new Map(),
    total: 0,
  };
  const wordMap = new Map<string, LearnedWord>();
  const correctionMap = new Map<string, number>();
  const practiceDays = new Set<string>();
  let totalMessages = 0;
  let totalCorrections = 0;

  for (const session of ordered) {
    accumulateSession(session, acc);
    for (const message of session.messages) {
      totalMessages++;
      practiceDays.add(dayKey(message.createdAt));

      if (message.role !== "ai") continue;

      const parsedWord = !isNoneLike(message.newWord)
        ? parseNewWord(message.newWord!)
        : null;
      if (parsedWord) {
        const key = parsedWord.word.toLowerCase();
        const existing = wordMap.get(key);
        if (existing) {
          existing.count++;
        } else {
          wordMap.set(key, {
            word: parsedWord.word,
            meaning: parsedWord.meaning,
            firstLearnedAt: message.createdAt,
            count: 1,
          });
        }
      }

      if (!isNoneLike(message.correction)) {
        const normalized = normalizeCorrection(message.correction!);
        if (normalized) {
          correctionMap.set(normalized, (correctionMap.get(normalized) ?? 0) + 1);
          totalCorrections++;
        }
      }
    }
  }

  const words = [...wordMap.values()].sort(
    (a, b) => a.firstLearnedAt - b.firstLearnedAt
  );
  const corrections = [...correctionMap.entries()]
    .map(([correction, count]) => ({ correction, count }))
    .sort((a, b) => b.count - a.count || a.correction.localeCompare(b.correction));

  const { current, longest } = calculateStreaks(practiceDays);

  return {
    sessions: ordered,
    totalSessions: ordered.length,
    totalMessages,
    totalMinutes: Math.round(acc.total / 60),
    totalPracticeDays: practiceDays.size,
    currentStreak: current,
    longestStreak: longest,
    words,
    totalWords: words.length,
    corrections,
    totalCorrections,
    daily: buildDaily(acc.secondsByDay),
  };
}

export function computeStats(messages: ChatMessage[]): ProgressStats {
  return computeStatsFromSessions(selectSessions(messages));
}

// --- Export helpers -------------------------------------------------------

function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function stamp(ts: number): string {
  return new Date(ts).toISOString();
}

export function exportSessionsJson(sessions: Session[]): void {
  const payload = {
    app: "English Buddy",
    exportedAt: new Date().toISOString(),
    sessions: sessions.map((s) => ({
      id: s.id,
      startedAt: s.startedAt,
      messages: s.messages.map((m) => ({
        id: m.id,
        createdAt: m.createdAt,
        role: m.role,
        text: m.text,
        praise: m.praise ?? null,
        correction: m.correction ?? null,
        newWord: m.newWord ?? null,
      })),
    })),
  };
  download(
    `english-buddy-${dayKey(Date.now())}.json`,
    JSON.stringify(payload, null, 2),
    "application/json"
  );
}

function csvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function exportMessagesCsv(sessions: Session[]): void {
  const rows = ["session_id,session_started,created_at,role,text,praise,correction,new_word"];
  for (const session of sessions) {
    for (const m of session.messages) {
      rows.push(
        [
          session.id,
          stamp(session.startedAt),
          stamp(m.createdAt),
          m.role,
          m.text,
          m.praise ?? "",
          m.correction ?? "",
          m.newWord ?? "",
        ]
          .map(csvCell)
          .join(",")
      );
    }
  }
  download(
    `english-buddy-${dayKey(Date.now())}.csv`,
    rows.join("\n"),
    "text/csv;charset=utf-8"
  );
}
