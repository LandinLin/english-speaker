"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import ChatTranscript from "@/components/ChatTranscript";
import { stopPlayback } from "@/lib/audioPlayer";
import {
  clearAllMessages,
  deleteSession,
  selectSessions,
  useMessages,
  type Session,
} from "@/lib/messageStore";
import { ACCENTS } from "@/lib/accentStore";

type FilterId = "all" | "chats" | "calls" | "lessons";

const FILTERS: { id: FilterId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "chats", label: "💬 Chats" },
  { id: "calls", label: "📞 Calls" },
  { id: "lessons", label: "📚 Lessons" },
];

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayLabel(ts: number): string {
  const today = startOfDay(Date.now());
  const day = startOfDay(ts);
  const dayMs = 24 * 60 * 60 * 1000;
  if (day === today) return "Today";
  if (day === today - dayMs) return "Yesterday";
  return new Date(ts).toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function sessionPreview(session: Session): string {
  const firstUser = session.messages.find((m) => m.role === "user");
  const text = firstUser?.text.trim() || "Chat with English Buddy";
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/** mm:ss / h:mm:ss for a persisted voice-call duration. */
function durationLabel(durationMs?: number): string | null {
  if (typeof durationMs !== "number" || durationMs <= 0) return null;
  const total = Math.round(durationMs / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Flag emoji for the accent used in a session, if known. */
function AccentFlag({ session }: { session: Session }) {
  const def = ACCENTS.find((a) => a.id === session.accent);
  if (!def) return null;
  return (
    <span
      title={`${def.label} teacher`}
      aria-label={`${def.label} teacher`}
      className="shrink-0 text-sm leading-none"
    >
      {def.emoji}
    </span>
  );
}

/** ⭐⭐☆-style rating, or a status pill for unfinished lessons. */
function LessonStatus({ session }: { session: Session }) {
  const steps =
    typeof session.completedSteps === "number" && session.totalSteps
      ? `${session.completedSteps}/${session.totalSteps} steps`
      : null;

  if (session.timedOut) {
    return (
      <span className="font-medium text-orange-500">
        ⏰ Time up{steps ? ` · ${steps}` : ""}
        {session.durationMinutes ? ` · ${session.durationMinutes} min` : ""}
      </span>
    );
  }

  const stars = session.starsEarned ?? 0;
  if (stars > 0) {
    return (
      <span className="flex flex-wrap items-center gap-x-1.5">
        <span className="tracking-tight text-amber-400">
          {"⭐".repeat(stars)}
          <span className="opacity-25 grayscale">
            {"⭐".repeat(Math.max(0, 3 - stars))}
          </span>
        </span>
        {session.durationMinutes ? (
          <span className="text-gray-400">· {session.durationMinutes} min</span>
        ) : null}
        {steps ? <span className="text-gray-400">· {steps}</span> : null}
        {session.correctionsCount ? (
          <span className="text-gray-400">
            · {session.correctionsCount} correction
            {session.correctionsCount === 1 ? "" : "s"}
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <span className="font-medium text-blue-400">
      🏃 In progress{steps ? ` · ${steps}` : ""}
    </span>
  );
}

interface DayGroup {
  label: string;
  key: number;
  sessions: Session[];
}

function SessionCard({ session }: { session: Session }) {
  const [expanded, setExpanded] = useState(false);
  const isLesson = session.type === "lesson";
  const isCall = session.type === "call";

  const toggle = () => {
    if (expanded) stopPlayback();
    setExpanded((v) => !v);
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    const what = isLesson ? "lesson" : isCall ? "call" : "conversation";
    if (!window.confirm(`Delete this ${what}?`)) return;
    stopPlayback();
    deleteSession(session.id);
  };

  const cardIcon = expanded
    ? "📂"
    : isCall
      ? "📞"
      : isLesson
        ? "📚"
        : "💬";
  const cardTitle = isCall
    ? session.title || "Voice Call"
    : isLesson
      ? session.lessonTitle || "English Lesson"
      : sessionPreview(session);
  const callDuration = durationLabel(session.durationMs);

  return (
    <div
      className={`overflow-hidden rounded-2xl border bg-white shadow-sm ${
        isCall ? "border-green-200" : "border-gray-200"
      }`}
    >
      <div className="flex w-full items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <span className="text-lg">{cardIcon}</span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium text-gray-800">
                {cardTitle}
              </span>
              {isCall && (
                <span className="shrink-0 rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-green-700">
                  Call
                </span>
              )}
              <AccentFlag session={session} />
            </span>
            <span className="mt-0.5 block text-xs">
              {isLesson ? (
                <LessonStatus session={session} />
              ) : (
                <span className="text-gray-400">
                  {timeLabel(session.startedAt)}
                  {isCall && callDuration ? ` · ${callDuration}` : ""} ·{" "}
                  {session.messages.length} messages
                </span>
              )}
            </span>
            {isLesson && (
              <span className="mt-0.5 block text-xs text-gray-400">
                {timeLabel(session.startedAt)} · {session.messages.length}{" "}
                messages
              </span>
            )}
            {isCall && (
              <span className="mt-0.5 block truncate text-xs text-gray-400">
                {sessionPreview(session)}
              </span>
            )}
          </span>
          <span className="text-xs text-gray-400">
            {expanded ? "▲" : "▼"}
          </span>
        </button>
        <button
          type="button"
          onClick={handleDelete}
          aria-label={
            isLesson
              ? "Delete lesson"
              : isCall
                ? "Delete call"
                : "Delete conversation"
          }
          className="rounded-full px-2 py-1 text-sm text-gray-400 hover:bg-red-50 hover:text-red-500"
        >
          🗑️
        </button>
      </div>

      {expanded && (
        <div
          className={`border-t px-3 py-4 ${
            isCall ? "border-green-100 bg-green-50/40" : "border-gray-100 bg-blue-50/40"
          }`}
        >
          <div className="mx-auto flex max-w-xl flex-col gap-3">
            {isCall && (
              <p className="text-center text-[11px] font-medium uppercase tracking-wide text-green-600/80">
                Voice call transcript · read-only
                {callDuration ? ` · ${callDuration}` : ""}
              </p>
            )}
            <ChatTranscript messages={session.messages} />
          </div>
        </div>
      )}
    </div>
  );
}

function HistoryContent() {
  const messages = useMessages();
  const router = useRouter();
  const searchParams = useSearchParams();

  const initialFilter: FilterId =
    searchParams.get("filter") === "lessons"
      ? "lessons"
      : searchParams.get("filter") === "chats"
        ? "chats"
        : searchParams.get("filter") === "calls"
          ? "calls"
          : "all";
  const [filter, setFilter] = useState<FilterId>(initialFilter);

  const changeFilter = (id: FilterId) => {
    setFilter(id);
    // Keep the URL shareable (the Lesson tab deep-links to ?filter=lessons).
    router.replace(id === "all" ? "/history" : `/history?filter=${id}`);
  };

  const { groups, chatCount, callCount, lessonCount } = useMemo(() => {
    const all = selectSessions(messages).slice().reverse(); // newest first
    let chats = 0;
    let calls = 0;
    let lessons = 0;
    for (const s of all) {
      if (s.type === "lesson") lessons += 1;
      else if (s.type === "call") calls += 1;
      else chats += 1;
    }
    const filtered =
      filter === "all"
        ? all
        : all.filter((s) =>
            filter === "lessons"
              ? s.type === "lesson"
              : filter === "calls"
                ? s.type === "call"
                : s.type !== "lesson" && s.type !== "call"
          );
    const byDay = new Map<number, DayGroup>();
    for (const session of filtered) {
      const key = startOfDay(session.startedAt);
      let group = byDay.get(key);
      if (!group) {
        group = { label: dayLabel(session.startedAt), key, sessions: [] };
        byDay.set(key, group);
      }
      group.sessions.push(session);
    }
    return {
      groups: [...byDay.values()].sort((a, b) => b.key - a.key),
      chatCount: chats,
      callCount: calls,
      lessonCount: lessons,
    };
  }, [messages, filter]);

  const handleClearAll = () => {
    if (!window.confirm("Delete ALL conversations? This cannot be undone."))
      return;
    stopPlayback();
    clearAllMessages();
  };

  const counts: Record<FilterId, number> = {
    all: chatCount + callCount + lessonCount,
    chats: chatCount,
    calls: callCount,
    lessons: lessonCount,
  };

  return (
    <main className="h-full overflow-y-auto">
      {/* Header */}
      <header className="flex items-center justify-between px-4 pb-2 pt-4">
        <h1 className="text-on-bg text-xl font-bold">📜 History</h1>
        {messages.length > 0 && (
          <button
            type="button"
            onClick={handleClearAll}
            className="rounded-full bg-white px-3 py-1.5 text-xs font-medium text-gray-600 shadow-sm transition-colors hover:bg-gray-50"
          >
            Clear all
          </button>
        )}
      </header>

      {/* Filter tabs */}
      <div className="mx-auto max-w-xl px-4">
        <div
          role="tablist"
          aria-label="Filter history"
          className="flex gap-1 rounded-full bg-white p-1 shadow-sm"
        >
          {FILTERS.map((tab) => {
            const active = filter === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => changeFilter(tab.id)}
                className={`flex flex-1 items-center justify-center gap-1 rounded-full px-2 py-1.5 text-xs font-bold transition-colors ${
                  active
                    ? "bg-blue-500 text-white shadow-sm"
                    : "text-gray-500 hover:bg-gray-50"
                }`}
              >
                {tab.label}
                <span
                  className={`rounded-full px-1.5 text-[10px] ${
                    active ? "bg-white/25" : "bg-gray-100 text-gray-400"
                  }`}
                >
                  {counts[tab.id]}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mx-auto max-w-xl px-4 py-3 pb-8">
        {groups.length === 0 ? (
          <div className="mt-20 flex flex-col items-center gap-3 text-center">
            <p className="text-5xl">🎈</p>
            <p className="text-gray-500">
              {filter === "lessons"
                ? "No lessons yet. Time to learn something fun!"
                : filter === "chats"
                  ? "No chats yet."
                  : filter === "calls"
                    ? "No voice calls yet. Try calling English Buddy!"
                    : "No conversations yet."}
            </p>
            <Link
              href={
                filter === "lessons"
                  ? "/lesson"
                  : filter === "calls"
                    ? "/call"
                    : "/"
              }
              className="rounded-full bg-blue-500 px-5 py-2 text-sm font-medium text-white shadow hover:bg-blue-600"
            >
              {filter === "lessons" ? "Start a lesson 📚" : "Start speaking"}
            </Link>
          </div>
        ) : (
          <div className="space-y-6">
            {groups.map((group) => (
              <section key={group.key}>
                <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-gray-400">
                  {group.label}
                </h2>
                <div className="space-y-2">
                  {group.sessions.map((session) => (
                    <SessionCard key={session.id} session={session} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

export default function HistoryPage() {
  // useSearchParams() needs a Suspense boundary during prerender.
  return (
    <Suspense
      fallback={
        <main className="h-full overflow-y-auto">
          <h1 className="text-on-bg px-4 pt-4 text-xl font-bold">📜 History</h1>
        </main>
      }
    >
      <HistoryContent />
    </Suspense>
  );
}
