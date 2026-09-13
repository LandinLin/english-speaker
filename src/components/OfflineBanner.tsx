"use client";

import { useSyncExternalStore } from "react";

/**
 * Top banner shown whenever the device is offline. The app keeps working
 * locally and queued voice messages are sent automatically on reconnect.
 */

function subscribe(listener: () => void): () => void {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

function getOnlineSnapshot(): boolean {
  return navigator.onLine;
}

function getServerOnlineSnapshot(): boolean {
  return true;
}

export default function OfflineBanner() {
  const online = useSyncExternalStore(
    subscribe,
    getOnlineSnapshot,
    getServerOnlineSnapshot
  );

  if (online) return null;

  return (
    <div
      className="fixed inset-x-0 top-0 z-50 bg-amber-400 px-4 pb-2 text-center text-xs font-bold text-amber-950 shadow-md"
      style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
    >
      📴 You&apos;re offline. Your messages will send when you&apos;re back
      online.
    </div>
  );
}
