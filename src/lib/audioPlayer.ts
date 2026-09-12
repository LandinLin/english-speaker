"use client";

import { useSyncExternalStore } from "react";

let currentAudio: HTMLAudioElement | null = null;
let playingId: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getPlayingIdSnapshot(): string | null {
  return playingId;
}

function getNullSnapshot(): null {
  return null;
}

export function usePlayingMessageId(): string | null {
  return useSyncExternalStore(
    subscribe,
    getPlayingIdSnapshot,
    getNullSnapshot
  );
}

function teardown(el: HTMLAudioElement): void {
  el.onended = null;
  el.onerror = null;
  if (currentAudio === el) {
    currentAudio = null;
    playingId = null;
    emit();
  }
}

/** Play an already-resolved data: URL. Calling with the same id stops it. */
export function playClip(id: string, src: string): void {
  if (playingId === id) {
    stopPlayback();
    return;
  }
  if (currentAudio) {
    const previous = currentAudio;
    previous.onended = null;
    previous.onerror = null;
    previous.pause();
    previous.src = "";
    currentAudio = null;
  }

  const el = new Audio(src);
  el.onended = () => teardown(el);
  el.onerror = () => {
    console.error("🔊 [audio] Playback failed");
    teardown(el);
  };
  currentAudio = el;
  playingId = id;
  emit();

  void el.play().catch((err) => {
    // Autoplay can still be blocked in rare cases; the Listen button retries.
    console.warn("🔊 [audio] Autoplay blocked, use the Listen button:", err);
    teardown(el);
  });
}

export function stopPlayback(): void {
  if (!currentAudio) return;
  const el = currentAudio;
  el.onended = null;
  el.onerror = null;
  el.pause();
  el.src = "";
  currentAudio = null;
  playingId = null;
  emit();
}
