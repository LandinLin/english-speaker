"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

export type MicroType = "correct" | "great" | "smart";

interface Props {
  /** When this value changes, the celebration fires. */
  trigger: number;
  type?: MicroType;
}

const CONFIG: Record<MicroType, { emoji: string; text: string; color: string }> = {
  correct: { emoji: "✅", text: "Correct!", color: "text-green-500" },
  great: { emoji: "🌟", text: "Great job!", color: "text-amber-500" },
  smart: { emoji: "💡", text: "Smart!", color: "text-yellow-500" },
};

/**
 * Inline micro-celebration for correct answers.
 * Uses framer-motion's natural enter/exit with a key derived from `trigger`
 * so each new correct answer replays the animation and auto-dismisses.
 */
export default function MicroCelebration({ trigger, type = "correct" }: Props) {
  const cfg = CONFIG[type];
  const [visible, setVisible] = useState(false);

  // Derive visibility purely from trigger: show when trigger changes (if > 0).
  // framer-motion's onAnimationComplete handles the auto-hide.
  const shouldShow = trigger > 0;

  if (shouldShow && !visible) {
    // defer to next tick to avoid render-phase state update
    queueMicrotask(() => setVisible(true));
  }

  return (
    <AnimatePresence
      onExitComplete={() => setVisible(false)}
    >
      {shouldShow && visible && (
        <motion.div
          key={trigger}
          initial={{ scale: 0, y: 20, opacity: 0 }}
          animate={{ scale: 1, y: 0, opacity: 1 }}
          exit={{ scale: 0, y: -20, opacity: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 15 }}
          onAnimationComplete={() => {
            // Auto-dismiss after a brief delay — use a simple timeout
            setTimeout(() => setVisible(false), 1200);
          }}
          className="pointer-events-none fixed left-1/2 top-1/3 z-50 -translate-x-1/2"
        >
          <div className="flex flex-col items-center">
            <span className="text-5xl">{cfg.emoji}</span>
            <span className={`mt-1 text-lg font-bold ${cfg.color}`}>
              {cfg.text}
            </span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
