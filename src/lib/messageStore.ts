"use client";

import { useSyncExternalStore } from "react";

export interface ChatMessage {
  id: string;
  sessionId: string;
  createdAt: number;
  role: "user" | "ai";
  text: string;
  praise?: string;
  correction?: string;
  newWord?: string;
  /** MP3 voice clip for AI messages. May be absent when evicted by storage quota. */
  audioBase64?: string;
}

export interface ExchangeInput {
  transcript: string;
  aiText: string;
  praise?: string;
  correction?: string;
  newWord?: string;
  audioBase64?: string;
}

export interface Session {
  id: string;
  startedAt: number;
  messages: ChatMessage[];
}

const MESSAGES_KEY = "english-buddy:messages";
const PENDING_KEY = "english-buddy:pending-new-session";
// A gap longer than this automatically starts a new conversation session.
const SESSION_GAP_MS = 30 * 60 * 1000;
const LEGACY_SESSION_ID = "legacy-conversation";

const EMPTY: ChatMessage[] = [];
const FALSE = false;

let cachedMessages: ChatMessage[] | null = null;
let cachedPending: boolean | null = null;
const listeners = new Set<() => void>();

function uid(): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return crypto.randomUUID();
    }
  } catch {
    // fall through to non-secure-context fallback
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isValidMessage(m: unknown): m is ChatMessage {
  if (m === null || typeof m !== "object") return false;
  const msg = m as Record<string, unknown>;
  return (
    (msg.role === "user" || msg.role === "ai") &&
    typeof msg.text === "string"
  );
}

/** Load + migrate messages saved by older versions of the app. */
function loadMessages(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(MESSAGES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed.filter(isValidMessage).map((m, index) => ({
      id: typeof m.id === "string" ? m.id : uid(),
      sessionId:
        typeof m.sessionId === "string" ? m.sessionId : LEGACY_SESSION_ID,
      createdAt: typeof m.createdAt === "number" ? m.createdAt : now + index,
      role: m.role,
      text: m.text,
      ...(m.praise !== undefined ? { praise: m.praise } : {}),
      ...(m.correction !== undefined ? { correction: m.correction } : {}),
      ...(m.newWord !== undefined ? { newWord: m.newWord } : {}),
      ...(m.audioBase64 !== undefined ? { audioBase64: m.audioBase64 } : {}),
    }));
  } catch {
    return [];
  }
}

function getMessagesSnapshot(): ChatMessage[] {
  if (cachedMessages === null) {
    cachedMessages = loadMessages();
  }
  return cachedMessages;
}

function getServerMessagesSnapshot(): ChatMessage[] {
  return EMPTY;
}

function getPendingSnapshot(): boolean {
  if (cachedPending === null) {
    cachedPending = localStorage.getItem(PENDING_KEY) === "1";
  }
  return cachedPending;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useMessages(): ChatMessage[] {
  return useSyncExternalStore(
    subscribe,
    getMessagesSnapshot,
    getServerMessagesSnapshot
  );
}

export function usePendingNewSession(): boolean {
  return useSyncExternalStore(
    subscribe,
    getPendingSnapshot,
    getPendingServerSnapshot
  );
}

function getPendingServerSnapshot(): boolean {
  return FALSE;
}

function emit(): void {
  listeners.forEach((listener) => listener());
}

/**
 * Persist messages. If localStorage is full, voice clips of the OLDEST AI
 * messages are dropped first (text/feedback always survive), then retry.
 */
function persist(next: ChatMessage[]): void {
  let data = next;
  for (;;) {
    try {
      localStorage.setItem(MESSAGES_KEY, JSON.stringify(data));
      cachedMessages = data;
      return;
    } catch (err) {
      const quotaError =
        err instanceof DOMException &&
        (err.name === "QuotaExceededError" || err.code === 22);
      if (!quotaError) {
        // Still keep in-memory state consistent even if writing failed.
        cachedMessages = data;
        console.error("💾 [store] Failed to persist messages:", err);
        return;
      }
      const oldestWithAudio = data.findIndex(
        (m) => m.role === "ai" && !!m.audioBase64
      );
      if (oldestWithAudio === -1) {
        console.warn("💾 [store] Storage full with no audio to drop");
        cachedMessages = data;
        return;
      }
      data = data.map((m, i) =>
        i === oldestWithAudio ? { ...m, audioBase64: undefined } : m
      );
    }
  }
}

function markPending(value: boolean): void {
  cachedPending = value;
  try {
    if (value) {
      localStorage.setItem(PENDING_KEY, "1");
    } else {
      localStorage.removeItem(PENDING_KEY);
    }
  } catch (err) {
    console.error("💾 [store] Failed to update session flag:", err);
  }
}

/** Decide which session the next spoken exchange belongs to. */
function resolveSessionId(): string {
  const messages = getMessagesSnapshot();
  if (getPendingSnapshot()) {
    markPending(false);
    return uid();
  }
  const last = messages[messages.length - 1];
  if (!last || Date.now() - last.createdAt > SESSION_GAP_MS) {
    return uid();
  }
  return last.sessionId;
}

export function addExchange(input: ExchangeInput): {
  user: ChatMessage;
  ai: ChatMessage;
} {
  const sessionId = resolveSessionId();
  const now = Date.now();
  const user: ChatMessage = {
    id: uid(),
    sessionId,
    createdAt: now,
    role: "user",
    text: input.transcript,
  };
  const ai: ChatMessage = {
    id: uid(),
    sessionId,
    createdAt: now + 1,
    role: "ai",
    text: input.aiText,
    praise: input.praise,
    correction: input.correction,
    newWord: input.newWord,
    audioBase64: input.audioBase64,
  };
  persist([...getMessagesSnapshot(), user, ai]);
  emit();
  return { user, ai };
}

/** Error/notice bubble; stays in the current (or a fresh) session. */
export function appendNotice(text: string): void {
  const messages = getMessagesSnapshot();
  let sessionId = messages[messages.length - 1]?.sessionId;
  if (!sessionId) {
    if (getPendingSnapshot()) markPending(false);
    sessionId = uid();
  }
  const notice: ChatMessage = {
    id: uid(),
    sessionId,
    createdAt: Date.now(),
    role: "ai",
    text,
  };
  persist([...messages, notice]);
  emit();
}

export function beginNewSession(): void {
  markPending(true);
  emit();
}

export function clearAllMessages(): void {
  persist([]);
  markPending(false);
  emit();
}

export function deleteSession(sessionId: string): void {
  persist(
    getMessagesSnapshot().filter((m) => m.sessionId !== sessionId)
  );
  emit();
}

/** Cache a lazily re-fetched voice clip back onto its message. */
export function setMessageAudio(id: string, audioBase64: string): void {
  persist(
    getMessagesSnapshot().map((m) =>
      m.id === id ? { ...m, audioBase64 } : m
    )
  );
  emit();
}

/** Group the flat message list into sessions, oldest first. */
export function selectSessions(messages: ChatMessage[]): Session[] {
  const sessions: Session[] = [];
  for (const message of messages) {
    const current = sessions[sessions.length - 1];
    if (current && current.id === message.sessionId) {
      current.messages.push(message);
    } else {
      sessions.push({
        id: message.sessionId,
        startedAt: message.createdAt,
        messages: [message],
      });
    }
  }
  return sessions;
}
