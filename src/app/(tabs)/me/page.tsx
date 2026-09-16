"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useMessages } from "@/lib/messageStore";
import { computeStats } from "@/lib/stats";
import { countEarnedBadges } from "@/lib/badges";
import { logout, useAuth } from "@/lib/authStore";

export default function MePage() {
  const messages = useMessages();
  const { user } = useAuth();

  const stats = useMemo(() => computeStats(messages), [messages]);
  const earnedBadgeCount = useMemo(
    () => countEarnedBadges(stats.sessions),
    [stats.sessions]
  );

  const handleLogout = () => {
    void logout();
  };

  return (
    <main className="flex h-full flex-col overflow-y-auto">
      {/* Profile header */}
      <header className="flex flex-col items-center px-4 pb-6 pt-8">
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-blue-100 to-purple-100 text-4xl shadow-sm">
          🐣
        </div>
        <h1 className="mt-3 text-xl font-bold text-gray-800">
          {user?.displayName ?? "English Learner"}
        </h1>
        <div className="mt-3 flex items-center gap-2">
          <span className="rounded-full bg-white px-4 py-1.5 text-sm font-semibold text-orange-500 shadow-sm">
            🔥 {stats.currentStreak}-day streak
          </span>
          <span className="rounded-full bg-white px-4 py-1.5 text-sm font-semibold text-amber-500 shadow-sm">
            🏆 {earnedBadgeCount} {earnedBadgeCount === 1 ? "badge" : "badges"}
          </span>
        </div>
      </header>

      {/* Menu */}
      <nav className="mx-auto w-full max-w-md space-y-2 px-4">
        <Link
          href="/history"
          className="flex min-h-[60px] items-center justify-between rounded-2xl bg-white px-5 py-3.5 shadow-sm transition-colors hover:bg-gray-50"
        >
          <span className="flex items-center gap-3">
            <span className="text-xl" aria-hidden>
              📜
            </span>
            <span className="font-semibold text-gray-700">History</span>
          </span>
          <span className="text-gray-300" aria-hidden>
            ›
          </span>
        </Link>

        <Link
          href="/dashboard"
          className="flex min-h-[60px] items-center justify-between rounded-2xl bg-white px-5 py-3.5 shadow-sm transition-colors hover:bg-gray-50"
        >
          <span className="flex items-center gap-3">
            <span className="text-xl" aria-hidden>
              📊
            </span>
            <span className="font-semibold text-gray-700">Dashboard</span>
          </span>
          <span className="text-gray-300" aria-hidden>
            ›
          </span>
        </Link>

        <button
          type="button"
          onClick={handleLogout}
          className="flex min-h-[60px] w-full items-center justify-between rounded-2xl bg-white px-5 py-3.5 shadow-sm transition-colors hover:bg-gray-50"
        >
          <span className="flex items-center gap-3">
            <span className="text-xl" aria-hidden>
              🚪
            </span>
            <span className="font-semibold text-gray-700">Log out</span>
          </span>
          <span className="text-gray-300" aria-hidden>
            ›
          </span>
        </button>
      </nav>

      <p className="mt-auto pb-4 pt-6 text-center text-xs text-gray-300">
        English Buddy · Practice makes perfect 🌟
      </p>
    </main>
  );
}
