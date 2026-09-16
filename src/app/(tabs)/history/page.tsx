"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import ChatTranscript from "@/components/ChatTranscript";
import { stopPlayback } from "@/lib/audioPlayer";
import {
  clearAllMessages,
  deleteSession,
  selectSessions,
  useMessages,
  type Session,
} from "@/lib/messageStore";

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

interface DayGroup {
  label: string;
  key: number;
  sessions: Session[];
}

function SessionCard({ session }: { session: Session }) {
  const [expanded, setExpanded] = useState(false);

  const toggle = () => {
    if (expanded) stopPlayback();
    setExpanded((v) => !v);
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm("Delete this conversation?")) return;
    stopPlayback();
    deleteSession(session.id);
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
      <div className="flex w-full items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <span className="text-lg">{expanded ? "📂" : "💬"}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-gray-800">
              {sessionPreview(session)}
            </span>
            <span className="mt-0.5 block text-xs text-gray-400">
              {timeLabel(session.startedAt)} · {session.messages.length}{" "}
              messages
            </span>
          </span>
          <span className="text-xs text-gray-400">
            {expanded ? "▲" : "▼"}
          </span>
        </button>
        <button
          type="button"
          onClick={handleDelete}
          aria-label="Delete conversation"
          className="rounded-full px-2 py-1 text-sm text-gray-400 hover:bg-red-50 hover:text-red-500"
        >
          🗑️
        </button>
      </div>

      {expanded && (
        <div className="border-t border-gray-100 bg-blue-50/40 px-3 py-4">
          <div className="mx-auto flex max-w-xl flex-col gap-3">
            <ChatTranscript messages={session.messages} />
          </div>
        </div>
      )}
    </div>
  );
}

export default function HistoryPage() {
  const messages = useMessages();

  const groups = useMemo<DayGroup[]>(() => {
    const sessions = selectSessions(messages).slice().reverse(); // newest first
    const byDay = new Map<number, DayGroup>();
    for (const session of sessions) {
      const key = startOfDay(session.startedAt);
      let group = byDay.get(key);
      if (!group) {
        group = { label: dayLabel(session.startedAt), key, sessions: [] };
        byDay.set(key, group);
      }
      group.sessions.push(session);
    }
    return [...byDay.values()].sort((a, b) => b.key - a.key);
  }, [messages]);

  const handleClearAll = () => {
    if (!window.confirm("Delete ALL conversations? This cannot be undone."))
      return;
    stopPlayback();
    clearAllMessages();
  };

  return (
    <main className="h-full overflow-y-auto bg-gradient-to-b from-blue-50 to-purple-50">
      {/* Header */}
      <header className="flex items-center justify-between px-4 pb-2 pt-4">
        <h1 className="text-xl font-bold text-gray-800">📜 History</h1>
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

      <div className="mx-auto max-w-xl px-4 py-3 pb-8">
        {groups.length === 0 ? (
          <div className="mt-20 flex flex-col items-center gap-3 text-center">
            <p className="text-5xl">🎈</p>
            <p className="text-gray-500">No conversations yet.</p>
            <Link
              href="/"
              className="rounded-full bg-blue-500 px-5 py-2 text-sm font-medium text-white shadow hover:bg-blue-600"
            >
              Start speaking
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
