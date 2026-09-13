"use client";

import Link from "next/link";
import { useMemo } from "react";
import { selectSessions, useMessages } from "@/lib/messageStore";
import {
  computeStatsFromSessions,
  exportMessagesCsv,
  exportSessionsJson,
} from "@/lib/stats";
import { checkBadges } from "@/lib/badges";

function StatCard({
  emoji,
  value,
  label,
  subtitle,
}: {
  emoji: string;
  value: string | number;
  label: string;
  subtitle?: string;
}) {
  return (
    <div className="rounded-2xl bg-white p-4 text-center shadow-sm">
      <div className="text-2xl">{emoji}</div>
      <div className="mt-1 text-2xl font-extrabold text-gray-800">{value}</div>
      <div className="text-xs font-medium text-gray-500">{label}</div>
      {subtitle && <div className="mt-0.5 text-[10px] text-gray-400">{subtitle}</div>}
    </div>
  );
}

function PracticeChart({
  daily,
}: {
  daily: ReturnType<typeof computeStatsFromSessions>["daily"];
}) {
  const maxMinutes = Math.max(...daily.map((d) => d.minutes), 1);
  const totalInWindow = daily.reduce((sum, d) => sum + d.minutes, 0);
  const activeDays = daily.filter((d) => d.minutes > 0).length;

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-bold text-gray-700">
          ⏱️ Practice minutes · last 30 days
        </h2>
        <span className="text-[11px] text-gray-400">
          {activeDays} active days · {Math.round(totalInWindow)} min
        </span>
      </div>
      <div className="flex h-36 items-end gap-[3px] rounded-2xl bg-blue-50/60 p-3">
        {daily.map((day) => {
          const heightPct =
            day.minutes > 0 ? Math.max((day.minutes / maxMinutes) * 100, 6) : 1.5;
          return (
            <div
              key={day.dateKey}
              className="group relative flex h-full flex-1 items-end"
              title={`${day.weekday} ${day.label}: ${day.minutes} min`}
            >
              <div
                className={`w-full rounded-t-md transition-all ${
                  day.isToday
                    ? "bg-amber-400"
                    : day.minutes > 0
                      ? "bg-gradient-to-t from-blue-500 to-purple-400"
                      : "bg-gray-200"
                }`}
                style={{ height: `${heightPct}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between px-3 text-[10px] text-gray-400">
        <span>30 days ago</span>
        <span>today →</span>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl bg-white p-4 shadow-sm">
      <h2 className="mb-3 text-sm font-bold text-gray-700">{title}</h2>
      {children}
    </section>
  );
}

export default function DashboardPage() {
  const messages = useMessages();
  const stats = useMemo(() => computeStatsFromSessions(selectSessions(messages)), [messages]);
  const badges = useMemo(() => checkBadges(stats.sessions), [stats.sessions]);
  const earnedCount = badges.filter((b) => b.unlocked).length;

  const handleExportJson = () => exportSessionsJson(stats.sessions);
  const handleExportCsv = () => exportMessagesCsv(stats.sessions);

  return (
    <main className="min-h-dvh bg-gradient-to-b from-blue-50 to-purple-50">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-gray-200/60 bg-white/80 px-4 py-4 backdrop-blur">
        <div className="relative mx-auto flex max-w-xl items-center justify-center">
          <Link
            href="/"
            className="absolute left-0 rounded-full border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 shadow-sm transition-colors hover:bg-gray-100"
          >
            ← Back
          </Link>
          <h1 className="text-xl font-bold text-gray-800">📊 My Progress</h1>
          {stats.totalSessions > 0 && (
            <div className="absolute right-0 flex gap-1.5">
              <button
                type="button"
                onClick={handleExportJson}
                className="rounded-full border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 shadow-sm transition-colors hover:bg-gray-100"
              >
                ⬇ JSON
              </button>
              <button
                type="button"
                onClick={handleExportCsv}
                className="rounded-full border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 shadow-sm transition-colors hover:bg-gray-100"
              >
                ⬇ CSV
              </button>
            </div>
          )}
        </div>
      </header>

      <div className="mx-auto max-w-xl space-y-4 px-4 py-5 pb-16">
        {stats.totalSessions === 0 ? (
          <div className="mt-20 flex flex-col items-center gap-3 text-center">
            <p className="text-5xl">📈</p>
            <p className="text-gray-500">
              No practice yet — say hello to English Buddy and watch your
              progress grow!
            </p>
            <Link
              href="/"
              className="rounded-full bg-blue-500 px-5 py-2 text-sm font-medium text-white shadow hover:bg-blue-600"
            >
              Start speaking
            </Link>
          </div>
        ) : (
          <>
            {/* Top stats */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard emoji="💬" value={stats.totalSessions} label="Sessions" />
              <StatCard
                emoji="⏱️"
                value={stats.totalMinutes}
                label="Minutes"
                subtitle="estimated"
              />
              <StatCard emoji="🗣️" value={stats.totalMessages} label="Messages" />
              <StatCard
                emoji="🔥"
                value={stats.currentStreak}
                label="Day streak"
                subtitle={`best ${stats.longestStreak} days`}
              />
            </div>

            <section className="rounded-2xl bg-white p-4 shadow-sm">
              <PracticeChart daily={stats.daily} />
            </section>

            {/* Badges */}
            <Section
              title={`🏆 Badges · ${earnedCount} of ${badges.length} earned`}
            >
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {badges.map(({ def, unlocked, progress, label }) => (
                  <div
                    key={def.id}
                    className={`rounded-2xl border p-3 text-center transition-all ${
                      unlocked
                        ? "border-amber-300 bg-amber-50 shadow-sm"
                        : "border-gray-200 bg-gray-50 opacity-70"
                    }`}
                    title={def.description}
                  >
                    <div
                      className={`text-3xl ${unlocked ? "" : "grayscale"}`}
                    >
                      {unlocked ? def.emoji : "🔒"}
                    </div>
                    <div className="mt-1 text-xs font-bold text-gray-700">
                      {def.name}
                    </div>
                    <div className="mt-0.5 text-[10px] leading-tight text-gray-400">
                      {def.description}
                    </div>
                    {unlocked ? (
                      <div className="mt-1.5 text-[10px] font-semibold text-amber-600">
                        Earned! 🎉
                      </div>
                    ) : (
                      <>
                        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-gray-200">
                          <div
                            className="h-full rounded-full bg-blue-400"
                            style={{ width: `${Math.round(progress * 100)}%` }}
                          />
                        </div>
                        <div className="mt-1 text-[10px] text-gray-400">
                          {label}
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </Section>

            {/* New words */}
            <Section title={`💡 New words learned · ${stats.totalWords}`}>
              {stats.words.length === 0 ? (
                <p className="text-xs text-gray-400">
                  No words collected yet — Buddy teaches one new word each
                  chat.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {[...stats.words].reverse().map((w) => (
                    <span
                      key={w.word.toLowerCase()}
                      className="rounded-full bg-purple-50 px-3 py-1 text-xs text-purple-700"
                      title={
                        w.meaning
                          ? `${w.word}: ${w.meaning}`
                          : "Practiced in conversation"
                      }
                    >
                      {w.word}
                      {w.meaning && (
                        <span className="text-purple-400"> · {w.meaning}</span>
                      )}
                      {w.count > 1 && (
                        <span className="ml-1 text-purple-300">×{w.count}</span>
                      )}
                    </span>
                  ))}
                </div>
              )}
            </Section>

            {/* Corrections */}
            <Section
              title={`✏️ Things to practice · ${stats.totalCorrections} tips`}
            >
              {stats.corrections.length === 0 ? (
                <p className="text-xs text-gray-400">
                  No fixes yet — keep chatting to collect gentle tips!
                </p>
              ) : (
                <ul className="space-y-2">
                  {stats.corrections.slice(0, 8).map((item) => {
                    const pct = Math.round(
                      (item.count / stats.corrections[0].count) * 100
                    );
                    return (
                      <li key={item.correction}>
                        <div className="flex items-center justify-between text-xs text-gray-600">
                          <span className="capitalize">{item.correction}</span>
                          <span className="ml-2 shrink-0 font-semibold text-blue-500">
                            ×{item.count}
                          </span>
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-gray-100">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-blue-400 to-purple-400"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Section>

            <p className="px-1 text-center text-[10px] leading-relaxed text-gray-400">
              Minutes are estimated from conversation activity (about 20 seconds
              per turn plus active chatting time). Everything is stored on this
              device under <span className="font-mono">english-buddy:sessions</span>.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
