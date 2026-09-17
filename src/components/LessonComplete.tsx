"use client";

import { useEffect } from "react";
import { motion } from "framer-motion";
import confetti from "canvas-confetti";
import type { Badge, LearningStats } from "@/lib/badges";

interface Props {
  stats: LearningStats;
  newBadges: Badge[];
  /** Stars earned in THIS lesson (3 = perfect, 2 = completed). */
  stars?: number;
  onPlayAgain: () => void;
  onExit: () => void;
}

export default function LessonComplete({
  stats,
  newBadges,
  stars,
  onPlayAgain,
  onExit,
}: Props) {
  // Star rating: caller passes this lesson's result; fall back to the legacy
  // global-stats heuristic for older callers.
  const starCount =
    typeof stars === "number" && stars > 0
      ? stars
      : stats.perfectLessons > 0
        ? 3
        : 2;

  useEffect(() => {
    const fire = () =>
      confetti({
        particleCount: 60,
        spread: 75,
        origin: { y: 0.4 },
        colors: ["#fbbf24", "#f97316", "#ec4899", "#8b5cf6", "#06b6d4"],
      });
    fire();
    const t1 = setTimeout(fire, 400);
    const t2 = setTimeout(fire, 800);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  const summary = `You learned: ${stats.lettersLearned.length > 0 ? stats.lettersLearned.map((l) => `${l} is for Apple`).join(", ") : "new words"}. You said ${stats.totalSentences} sentences.`;

  return (
    <div className="relative flex h-full flex-col items-center justify-center overflow-hidden bg-gradient-to-b from-yellow-50 via-pink-50 to-purple-50 px-6 text-center">
      {/* Confetti emojis falling */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {Array.from({ length: 16 }).map((_, i) => (
          <motion.span
            key={i}
            className="absolute text-2xl"
            style={{ left: `${(i * 6 + 4) % 100}%` }}
            initial={{ y: -30, opacity: 0 }}
            animate={{ y: "110vh", opacity: [0, 1, 0.3] }}
            transition={{
              duration: 2.5 + (i % 3) * 0.8,
              repeat: Infinity,
              delay: i * 0.18,
              ease: "linear",
            }}
          >
            {["🎉", "⭐", "🎊", "✨", "🌟", "🎈"][i % 6]}
          </motion.span>
        ))}
      </div>

      <div className="relative z-10 flex flex-col items-center gap-4">
        {/* Heading */}
        <motion.h1
          initial={{ scale: 0, rotate: -10 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: "spring", stiffness: 200, damping: 12 }}
          className="text-3xl font-extrabold text-orange-500"
        >
          AMAZING JOB! 🎉
        </motion.h1>

        {/* Star rating */}
        <div className="flex gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <motion.span
              key={i}
              initial={{ scale: 0, rotate: -30 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ delay: 0.3 + i * 0.15, type: "spring", stiffness: 200 }}
              className={`text-5xl ${i < starCount ? "" : "opacity-20 grayscale"}`}
            >
              ⭐
            </motion.span>
          ))}
        </div>

        {/* Summary */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.6 }}
          className="max-w-sm rounded-2xl bg-white/90 px-6 py-4 shadow-lg"
        >
          <p className="text-sm font-medium text-gray-700">{summary}</p>
        </motion.div>

        {/* New badges */}
        {newBadges.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.8 }}
            className="flex flex-col items-center gap-2"
          >
            <p className="text-sm font-bold text-purple-600">
              🏅 New Badges Earned!
            </p>
            <div className="flex flex-wrap justify-center gap-3">
              {newBadges.map((badge) => (
                <motion.div
                  key={badge.id}
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{
                    delay: 1 + newBadges.indexOf(badge) * 0.15,
                    type: "spring",
                    stiffness: 200,
                  }}
                  className="flex flex-col items-center rounded-2xl bg-yellow-100 px-4 py-2 shadow-md"
                >
                  <span className="text-4xl">{badge.emoji}</span>
                  <span className="mt-0.5 text-xs font-bold text-gray-700">
                    {badge.name}
                  </span>
                </motion.div>
              ))}
            </div>
          </motion.div>
        )}

        {/* Buttons */}
        <div className="flex flex-col gap-2 pt-2 sm:flex-row sm:justify-center">
          <motion.button
            type="button"
            onClick={onPlayAgain}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1.2 }}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            className="rounded-full bg-blue-500 px-8 py-3.5 text-sm font-bold text-white shadow-lg transition-colors hover:bg-blue-600"
            style={{ minHeight: 60 }}
          >
            🔁 Play Again
          </motion.button>
          <motion.button
            type="button"
            onClick={onExit}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1.3 }}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            className="rounded-full bg-purple-400 px-8 py-3.5 text-sm font-bold text-white shadow-lg transition-colors hover:bg-purple-500"
            style={{ minHeight: 60 }}
          >
            👋 See You Tomorrow!
          </motion.button>
        </div>
      </div>
    </div>
  );
}
