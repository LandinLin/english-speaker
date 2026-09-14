"use client";

import { useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import confetti from "canvas-confetti";
import type { Badge } from "@/lib/badges";

interface Props {
  badge: Badge | null;
  onDismiss: () => void;
}

export default function BadgeUnlock({ badge, onDismiss }: Props) {
  // Fire confetti when a badge appears
  useEffect(() => {
    if (!badge) return;

    const fire = (origin: { x: number; y: number }) => {
      confetti({
        particleCount: 80,
        spread: 70,
        startVelocity: 45,
        origin,
        colors: ["#fbbf24", "#f97316", "#ec4899", "#8b5cf6", "#06b6d4"],
        scalar: 1.2,
      });
    };

    fire({ x: 0.2, y: 0.6 });
    setTimeout(() => fire({ x: 0.8, y: 0.6 }), 150);
    setTimeout(() => fire({ x: 0.5, y: 0.5 }), 300);

    const timer = setTimeout(onDismiss, 5000);
    return () => clearTimeout(timer);
  }, [badge, onDismiss]);

  return (
    <AnimatePresence>
      {badge && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onDismiss}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
        >
          {/* Sparkles */}
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            {Array.from({ length: 12 }).map((_, i) => (
              <motion.span
                key={i}
                className="absolute text-3xl"
                style={{
                  left: `${10 + (i * 8) % 80}%`,
                  top: `${15 + (i * 17) % 70}%`,
                }}
                animate={{
                  scale: [0, 1.4, 0],
                  opacity: [0, 1, 0],
                  rotate: [0, 180],
                }}
                transition={{
                  duration: 1.8,
                  repeat: Infinity,
                  delay: i * 0.12,
                }}
              >
                {["✨", "⭐", "💫", "🌟"][i % 4]}
              </motion.span>
            ))}
          </div>

          {/* Badge card */}
          <motion.div
            initial={{ scale: 0, rotate: -15 }}
            animate={{ scale: 1, rotate: 0 }}
            exit={{ scale: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 200, damping: 15 }}
            className="relative z-10 flex flex-col items-center rounded-[2rem] bg-gradient-to-b from-yellow-50 to-orange-50 px-10 py-8 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="mb-1 text-sm font-bold text-orange-500">
              🎉 Badge Unlocked!
            </p>

            <motion.div
              animate={{ scale: [1, 1.15, 1] }}
              transition={{ duration: 1.2, repeat: Infinity }}
              className="text-6xl"
            >
              {badge.emoji}
            </motion.div>

            <motion.h2
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
              className="mt-3 text-2xl font-extrabold text-gray-800"
            >
              {badge.name}
            </motion.h2>

            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.5 }}
              className="mt-1 text-sm text-gray-500"
            >
              {badge.description}
            </motion.p>

            <button
              type="button"
              onClick={onDismiss}
              className="mt-6 rounded-full bg-orange-400 px-8 py-3 text-sm font-bold text-white shadow-lg transition-colors hover:bg-orange-500"
            >
              Tap to continue! 👆
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
