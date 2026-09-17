"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useMessages } from "@/lib/messageStore";
import { computeStats, dayKey } from "@/lib/stats";
import { countEarnedBadges } from "@/lib/badges";
import { logout, useAuth } from "@/lib/authStore";
import { THEMES, setTheme, useTheme } from "@/lib/theme";
import AccentPicker from "@/components/AccentPicker";

const WEEK_LETTERS = ["M", "T", "W", "T", "F", "S", "S"] as const;

function streakCaption(count: number): string {
  if (count === 0) return "Start today!";
  if (count === 1) return "Great start!";
  if (count <= 4) return "Keep going!";
  if (count <= 6) return "On fire!";
  return "Unstoppable!";
}

function badgeCaption(count: number): string {
  if (count === 0) return "Earn your first!";
  if (count <= 2) return "Nice progress!";
  if (count <= 5) return "Badge collector!";
  return "Super collector!";
}

function timeGreeting(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export default function MePage() {
  const messages = useMessages();
  const { user } = useAuth();
  const theme = useTheme();

  const stats = useMemo(() => computeStats(messages), [messages]);
  const earnedBadgeCount = useMemo(
    () => countEarnedBadges(stats.sessions),
    [stats.sessions]
  );
  const name = user?.displayName || user?.username || "English Learner";
  // Time-dependent: SSR and client may disagree by minutes; suppress the
  // hydration warning for this line only.
  const greeting = timeGreeting(new Date().getHours());

  const isMilestone = [3, 7, 14, 30, 50, 100].includes(stats.currentStreak);

  // This week (Monday-first): practiced days come from the 30-day chart data.
  const week = useMemo(() => {
    const byDate = new Map(stats.daily.map((d) => [d.dateKey, d]));
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const mondayOffset = (today.getDay() + 6) % 7; // 0 = Monday
    const monday = new Date(today);
    monday.setDate(today.getDate() - mondayOffset);
    return WEEK_LETTERS.map((letter, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      const entry = byDate.get(dayKey(d.getTime()));
      return {
        letter,
        practiced: !!entry && entry.minutes > 0,
        minutes: entry?.minutes ?? 0,
        weekday: entry?.weekday ?? "",
        label: entry?.label ?? "",
      };
    });
  }, [stats.daily]);

  const activeTheme = THEMES.find((t) => t.id === theme);

  const handleLogout = () => {
    void logout();
  };

  return (
    <main className="app-bg h-full overflow-y-auto">
      {/* ── Hero profile ─────────────────────────────────────────────── */}
      <header className="relative flex flex-col items-center px-4 pb-6 pt-16">
        {/* Soft breathing glow behind the avatar, tinted by the theme. */}
        <div
          aria-hidden
          className="animate-glow-pulse pointer-events-none absolute inset-x-0 top-0 h-64"
          style={{
            background:
              "radial-gradient(ellipse 55% 60% at 50% 0%, color-mix(in oklab, var(--accent) 28%, transparent), transparent 70%)",
          }}
        />
        <div className="relative">
          <div className="flex h-[120px] w-[120px] items-center justify-center rounded-full bg-gradient-to-br from-blue-100 to-purple-100 text-6xl shadow-lg">
            🐣
          </div>
        </div>
        {/* Single heading: time greeting + display name (no duplicate name). */}
        <h1
          suppressHydrationWarning
          className="text-on-bg mt-4 text-xl font-bold"
        >
          {greeting}, {name}! 👋
        </h1>
      </header>

      {/* ── Stat cards ───────────────────────────────────────────────── */}
      <section className="mx-auto grid w-full max-w-md grid-cols-2 gap-3 px-4">
        <div
          className={`rounded-3xl border border-orange-200 bg-gradient-to-br from-orange-50 to-amber-50 px-4 py-4 text-center shadow-sm ${
            isMilestone ? "animate-milestone" : ""
          }`}
        >
          <div className="flex items-center justify-center gap-1.5">
            <span className="text-2xl" aria-hidden>
              🔥
            </span>
            <span
              className="text-2xl font-extrabold tabular-nums"
              style={{ color: "var(--accent)" }}
            >
              {stats.currentStreak}
            </span>
          </div>
          <div className="mt-0.5 text-xs font-medium text-gray-500">
            {streakCaption(stats.currentStreak)}
          </div>
        </div>
        <div className="rounded-3xl border border-amber-200 bg-gradient-to-br from-amber-50 to-yellow-50 px-4 py-4 text-center shadow-sm">
          <div className="flex items-center justify-center gap-1.5">
            <span className="text-2xl" aria-hidden>
              🏆
            </span>
            <span
              className="text-2xl font-extrabold tabular-nums"
              style={{ color: "var(--accent)" }}
            >
              {earnedBadgeCount}
            </span>
          </div>
          <div className="mt-0.5 text-xs font-medium text-gray-500">
            {badgeCaption(earnedBadgeCount)}
          </div>
        </div>
      </section>

      {/* ── Theme picker: mini preview cards ─────────────────────────── */}
      <section className="mx-auto mt-7 w-full max-w-md px-4">
        <h2 className="text-on-bg mb-2.5 px-1 text-sm font-medium opacity-80">
          🎨 {activeTheme?.emoji} {activeTheme?.label}
        </h2>
        <div className="grid grid-cols-3 gap-3">
          {THEMES.map((t) => {
            const selected = theme === t.id;
            return (
              <button
                key={t.id}
                type="button"
                aria-label={`${t.label} theme`}
                aria-pressed={selected}
                title={t.label}
                onClick={() => setTheme(t.id)}
                className={`relative flex h-20 w-full items-end rounded-2xl border p-2 shadow-sm transition-transform ${
                  t.id === "night" ? "border-gray-300" : "border-black/5"
                } ${
                  selected
                    ? "scale-105 ring-2 ring-blue-500 ring-offset-2"
                    : "hover:scale-105"
                }`}
                style={{ background: t.swatch }}
              >
                <span
                  aria-hidden
                  className="absolute right-1.5 top-1.5 text-sm"
                >
                  {t.emoji}
                </span>
                {/* Mini card preview */}
                <span
                  className="h-6 w-11 rounded-md shadow-sm"
                  style={{ background: t.cardSwatch }}
                />
                {selected && (
                  <span className="absolute inset-0 m-auto flex h-7 w-7 items-center justify-center rounded-full bg-blue-500 text-xs font-bold text-white shadow-md">
                    ✓
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </section>

      {/* ── Teacher voice: accent + gender + preview ─────────────────── */}
      <AccentPicker />

      {/* ── This week mini-chart ─────────────────────────────────────── */}
      <section className="mx-auto mt-7 w-full max-w-md px-4">
        <div className="rounded-3xl bg-white px-5 py-4 shadow-sm">
          <h2 className="text-sm font-bold text-gray-700">📅 This week</h2>
          <div className="mt-3 grid grid-cols-7 gap-3">
            {week.map((day, i) => (
              <div
                key={`${i}-${day.letter}`}
                className="flex flex-col items-center gap-1"
              >
                <div
                  role="img"
                  aria-label={
                    day.practiced
                      ? `${day.weekday} ${day.label}: ${day.minutes} min practiced`
                      : `${day.weekday} ${day.label}: no practice`
                  }
                  title={
                    day.practiced
                      ? `${day.weekday} ${day.label} · ${day.minutes} min`
                      : `${day.weekday} ${day.label} · no practice`
                  }
                  className={`h-10 w-10 rounded-xl ${
                    day.practiced ? "" : "bg-gray-200"
                  }`}
                  style={
                    day.practiced ? { background: "var(--accent)" } : undefined
                  }
                />
                <span className="text-[10px] font-medium text-gray-400">
                  {day.letter}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Menu: one card, divider rows ─────────────────────────────── */}
      <nav className="mx-auto mb-8 mt-7 w-full max-w-md px-4">
        <div className="overflow-hidden rounded-3xl bg-white shadow-sm">
          <Link
            href="/history"
            className="flex items-center gap-3 px-5 py-4 transition-colors hover:bg-gray-50"
          >
            <span className="text-xl" aria-hidden>
              📜
            </span>
            <span className="flex-1 font-semibold text-gray-700">History</span>
            <span className="text-lg text-gray-300" aria-hidden>
              ›
            </span>
          </Link>
          <div className="border-t border-gray-100" />
          <Link
            href="/dashboard"
            className="flex items-center gap-3 px-5 py-4 transition-colors hover:bg-gray-50"
          >
            <span className="text-xl" aria-hidden>
              📊
            </span>
            <span className="flex-1 font-semibold text-gray-700">
              Dashboard
            </span>
            <span className="text-lg text-gray-300" aria-hidden>
              ›
            </span>
          </Link>
          <div className="border-t border-gray-100" />
          <button
            type="button"
            onClick={handleLogout}
            className="flex w-full items-center gap-3 px-5 py-4 transition-colors hover:bg-gray-50"
          >
            <span className="text-xl" aria-hidden>
              🚪
            </span>
            <span className="flex-1 text-left font-semibold text-red-500">
              Log out
            </span>
            <span className="text-lg text-gray-300" aria-hidden>
              ›
            </span>
          </button>
        </div>
      </nav>
    </main>
  );
}
