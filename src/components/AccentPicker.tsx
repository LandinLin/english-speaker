"use client";

import { useEffect, useRef, useState } from "react";
import { ACCENTS, setAccent, useAccent } from "@/lib/accent";

/**
 * Compact flag pill that opens a small accent menu. Used in the Chat header
 * and the Lesson progress bar so the teacher's voice can be chosen BEFORE
 * the child starts speaking.
 */
export default function AccentPicker({ compact = false }: { compact?: boolean }) {
  const accent = useAccent();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handleDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleDown);
    return () => document.removeEventListener("mousedown", handleDown);
  }, [open]);

  const active = ACCENTS.find((a) => a.id === accent) ?? ACCENTS[0];

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Teacher accent: ${active.label}. Click to change.`}
        className="flex h-9 items-center gap-1 rounded-full bg-white px-3 text-sm font-semibold text-gray-600 shadow-sm transition-colors hover:bg-gray-50"
      >
        <span className="text-base leading-none">{active.emoji}</span>
        {!compact && <span>{active.label}</span>}
        <span className="text-[10px] text-gray-400">▾</span>
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Choose teacher accent"
          className="absolute right-0 z-30 mt-2 w-52 overflow-hidden rounded-2xl border border-gray-100 bg-white p-1.5 shadow-xl"
        >
          <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-bold uppercase tracking-wide text-gray-400">
            🗣️ Teacher accent
          </p>
          {ACCENTS.map((a) => {
            const selected = a.id === accent;
            return (
              <button
                key={a.id}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  setAccent(a.id);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors ${
                  selected ? "bg-blue-50" : "hover:bg-gray-50"
                }`}
              >
                <span className="text-xl leading-none">{a.emoji}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-gray-800">
                    {a.label}
                  </span>
                  <span className="block truncate text-[11px] text-gray-400">
                    {a.hint}
                  </span>
                </span>
                {selected && (
                  <span className="text-sm font-bold text-blue-500">✓</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
