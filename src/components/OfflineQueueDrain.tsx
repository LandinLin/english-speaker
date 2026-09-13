"use client";

import { useEffect } from "react";
import {
  getQueuedExchanges,
  removeQueuedExchange,
} from "@/lib/offlineQueue";

/**
 * Drains the IndexedDB outbox: on mount and whenever the browser goes back
 * online, queued voice recordings are POSTed to /api/conversation in order.
 * Each successful response is broadcast on the window as
 * "english-buddy:exchange" so the chat page can append it and play the voice.
 */
let draining = false;

interface ConversationResponse {
  transcript?: string;
  aiText?: string;
  feedback?: { praise?: string; correction?: string; newWord?: string };
  audioBase64?: string;
}

async function drainQueue(): Promise<void> {
  if (draining || typeof window === "undefined") return;
  if (!navigator.onLine) return;
  draining = true;
  try {
    const queued = await getQueuedExchanges();
    for (const item of queued) {
      if (item.id === undefined) continue;
      try {
        const formData = new FormData();
        formData.append(
          "audio",
          new File([item.audio], "speech.webm", {
            type: item.audio.type || "audio/webm",
          })
        );
        formData.append("history", JSON.stringify(item.history ?? []));

        const res = await fetch("/api/conversation", {
          method: "POST",
          body: formData,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as ConversationResponse;

        await removeQueuedExchange(item.id);
        window.dispatchEvent(
          new CustomEvent<ConversationResponse>("english-buddy:exchange", {
            detail: data,
          })
        );
      } catch {
        // Still offline / server unreachable: keep the rest queued.
        break;
      }
    }
  } finally {
    draining = false;
  }
}

export default function OfflineQueueDrain() {
  useEffect(() => {
    const handleOnline = () => {
      void drainQueue();
    };
    window.addEventListener("online", handleOnline);
    // Also attempt on load in case the queue was left non-empty.
    void drainQueue();
    return () => window.removeEventListener("online", handleOnline);
  }, []);

  return null;
}
