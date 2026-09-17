"use client";

import { useSyncExternalStore } from "react";
import { scopedKey } from "./userScope";

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
  /** Teacher accent used for this chat exchange (tags session history). */
  accent?: string;
}

export type SessionType = "chat" | "lesson";

/** Lesson-specific results stored alongside the session. */
export interface SessionLessonFields {
  lessonId?: string;
  lessonTitle?: string;
  durationMinutes?: number;
  completedSteps?: number;
  totalSteps?: number;
  starsEarned?: number;
  correctionsCount?: number;
  /** True when the 10-minute timer expired before the lesson finished. */
  timedOut?: boolean;
}

/** Persisted session metadata (mirrors the session_meta DB table). */
export interface SessionMeta extends SessionLessonFields {
  id: string;
  type: SessionType;
  /** Teacher accent used in this session, for the flag on history cards. */
  accent?: string;
  updatedAt: number;
}

export interface Session extends SessionLessonFields {
  id: string;
  startedAt: number;
  messages: ChatMessage[];
  /** Sessions without a metadata row are legacy chats. */
  type: SessionType;
  accent?: string;
}

/** Canonical storage: grouped, versioned sessions (per user). */
const SESSIONS_BASE = "english-buddy:sessions";
/** Per-session metadata (chat/lesson typing + lesson results). */
const SESSION_META_BASE = "english-buddy:session-meta";
/** Older app versions kept a flat message list here; migrated on first load. */
const LEGACY_MESSAGES_BASE = "english-buddy:messages";
const PENDING_BASE = "english-buddy:pending-new-session";

function sessionsKey(): string {
  return scopedKey(SESSIONS_BASE);
}
function sessionMetaKey(): string {
  return scopedKey(SESSION_META_BASE);
}
function legacyMessagesKey(): string {
  return scopedKey(LEGACY_MESSAGES_BASE);
}
function pendingKey(): string {
  return scopedKey(PENDING_BASE);
}
// A gap longer than this automatically starts a new conversation session.
const SESSION_GAP_MS = 30 * 60 * 1000;
const LEGACY_SESSION_ID = "legacy-conversation";
const STORAGE_VERSION = 1;

const EMPTY: ChatMessage[] = [];
const FALSE = false;

let cachedMessages: ChatMessage[] | null = null;
let cachedPending: boolean | null = null;
let cachedMeta: SessionMeta[] | null = null;
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

function normalizeMessage(
  m: unknown,
  index: number,
  fallbackSessionId = LEGACY_SESSION_ID,
  fallbackTime = Date.now()
): ChatMessage | null {
  if (!isValidMessage(m)) return null;
  return {
    id: typeof m.id === "string" ? m.id : uid(),
    sessionId:
      typeof m.sessionId === "string" ? m.sessionId : fallbackSessionId,
    createdAt:
      typeof m.createdAt === "number" ? m.createdAt : fallbackTime + index,
    role: m.role,
    text: m.text,
    ...(m.praise !== undefined ? { praise: m.praise } : {}),
    ...(m.correction !== undefined ? { correction: m.correction } : {}),
    ...(m.newWord !== undefined ? { newWord: m.newWord } : {}),
    ...(m.audioBase64 !== undefined ? { audioBase64: m.audioBase64 } : {}),
  };
}

/** Flatten any accepted on-disk shape into the ordered flat message list. */
function flattenStored(parsed: unknown): ChatMessage[] {
  const now = Date.now();
  const hasEnvelope =
    parsed !== null &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { sessions?: unknown }).sessions);
  const rawSessions: unknown[] = hasEnvelope
    ? ((parsed as { sessions: unknown[] }).sessions)
    : Array.isArray(parsed)
      ? (parsed as unknown[])
      : [];

  const out: ChatMessage[] = [];
  rawSessions.forEach((entry) => {
    if (!entry || typeof entry !== "object") return;
    const group = entry as {
      id?: unknown;
      startedAt?: unknown;
      messages?: unknown;
    };
    if (Array.isArray(group.messages)) {
      // Grouped session shape: { id, startedAt, messages: [...] }
      const sessionId =
        typeof group.id === "string" ? group.id : LEGACY_SESSION_ID;
      const startedAt =
        typeof group.startedAt === "number" ? group.startedAt : now;
      group.messages.forEach((m, i) => {
        const normalized = normalizeMessage(m, i, sessionId, startedAt);
        if (normalized) out.push(normalized);
      });
    } else {
      // Legacy flat message shape
      const normalized = normalizeMessage(entry, out.length);
      if (normalized) out.push(normalized);
    }
  });
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/** Load + migrate messages saved by older versions of the app. */
function loadMessages(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(sessionsKey());
    let migratedFromLegacy = false;
    let parsed: unknown = null;

    if (raw) {
      parsed = JSON.parse(raw);
    } else {
      const legacyRaw = localStorage.getItem(legacyMessagesKey());
      if (legacyRaw) {
        parsed = JSON.parse(legacyRaw);
        migratedFromLegacy = true;
      }
    }
    if (parsed === null) return [];

    const messages = flattenStored(parsed);
    if (migratedFromLegacy && messages.length > 0) {
      // One-time migration: write the grouped format to the new key.
      persist(messages);
      localStorage.removeItem(legacyMessagesKey());
    }
    return messages;
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

// ---------------------------------------------------------------------------
// Session metadata (chat/lesson typing + lesson result fields)
// ---------------------------------------------------------------------------

const META_NUMBER_FIELDS = [
  "durationMinutes",
  "completedSteps",
  "totalSteps",
  "starsEarned",
  "correctionsCount",
] as const;

const META_STRING_FIELDS = ["lessonId", "lessonTitle", "accent"] as const;

function normalizeSessionMeta(m: unknown): SessionMeta | null {
  if (m === null || typeof m !== "object") return null;
  const row = m as Record<string, unknown>;
  if (typeof row.id !== "string") return null;
  if (row.type !== "chat" && row.type !== "lesson") return null;
  if (typeof row.updatedAt !== "number") return null;

  const meta: SessionMeta = {
    id: row.id,
    type: row.type,
    updatedAt: row.updatedAt,
  };
  const target = meta as unknown as Record<string, unknown>;
  for (const field of META_STRING_FIELDS) {
    if (typeof row[field] === "string") {
      target[field] = row[field];
    }
  }
  for (const field of META_NUMBER_FIELDS) {
    if (typeof row[field] === "number") {
      target[field] = row[field];
    }
  }
  if (row.timedOut === true) meta.timedOut = true;
  return meta;
}

function loadSessionMeta(): SessionMeta[] {
  try {
    const raw = localStorage.getItem(sessionMetaKey());
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeSessionMeta)
      .filter((m): m is SessionMeta => m !== null);
  } catch {
    return [];
  }
}

function getMetaSnapshot(): SessionMeta[] {
  if (cachedMeta === null) {
    cachedMeta = loadSessionMeta();
  }
  return cachedMeta;
}

function persistMeta(next: SessionMeta[]): void {
  cachedMeta = next;
  try {
    localStorage.setItem(sessionMetaKey(), JSON.stringify(next));
  } catch (err) {
    console.error("💾 [store] Failed to persist session meta:", err);
  }
}

function serverPostMeta(sessions: SessionMeta[]): void {
  if (sessions.length === 0) return;
  void fetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessions }),
  }).catch((err) => {
    console.error("🗄️ [store] Session meta save failed:", err);
  });
}

function serverDeleteMeta(id?: string): void {
  const url = id
    ? `/api/sessions?id=${encodeURIComponent(id)}`
    : "/api/sessions?all=1";
  void fetch(url, { method: "DELETE" }).catch((err) => {
    console.error("🗄️ [store] Session meta delete failed:", err);
  });
}

/** Create or update a session's metadata (e.g. lesson start/results). */
export function saveSessionMeta(input: SessionMeta): void {
  const meta = normalizeSessionMeta(input);
  if (!meta) return;
  const current = getMetaSnapshot();
  const others = current.filter((m) => m.id !== meta.id);
  persistMeta([...others, meta]);
  emit();
  serverPostMeta([meta]);
}

function getPendingSnapshot(): boolean {
  if (cachedPending === null) {
    cachedPending = localStorage.getItem(pendingKey()) === "1";
  }
  return cachedPending;
}

function subscribe(listener: () => void): () => void {
  // First client subscription triggers the one-time server sync.
  if (typeof window !== "undefined") serverSync();
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

// ---------------------------------------------------------------------------
// Server sync (SQLite via /api/messages).
// localStorage stays as an instant-read cache; the database is the durable
// source of truth. All mutations optimistically update the cache and are then
// pushed to the server fire-and-forget.
// ---------------------------------------------------------------------------

let syncStarted = false;

function serverSync(): void {
  if (syncStarted) return;
  syncStarted = true;
  void (async () => {
    try {
      const [msgsRes, metaRes] = await Promise.all([
        fetch("/api/messages", { cache: "no-store" }),
        fetch("/api/sessions", { cache: "no-store" }),
      ]);
      // 401 is expected before login / after logout — authStore re-runs the
      // sync when the user changes, so skip silently instead of erroring.
      if (msgsRes.status === 401 || metaRes.status === 401) return;
      if (!msgsRes.ok) throw new Error(`messages HTTP ${msgsRes.status}`);

      // ── Session metadata ──────────────────────────────────────────────
      if (metaRes.ok) {
        const metaData: { sessions?: SessionMeta[] } = await metaRes.json();
        const serverMeta = Array.isArray(metaData.sessions)
          ? metaData.sessions
              .map(normalizeSessionMeta)
              .filter((m): m is SessionMeta => m !== null)
          : [];
        const localMeta = getMetaSnapshot();
        const byId = new Map<string, SessionMeta>();
        for (const m of localMeta) byId.set(m.id, m);
        for (const m of serverMeta) byId.set(m.id, m);
        const mergedMeta = [...byId.values()].sort(
          (a, b) => a.updatedAt - b.updatedAt
        );
        const metaChanged =
          mergedMeta.length !== localMeta.length ||
          mergedMeta.some(
            (m, i) =>
              m !== localMeta[i] ||
              JSON.stringify(m) !== JSON.stringify(localMeta[i])
          );
        if (metaChanged) persistMeta(mergedMeta);
        // Push local-only meta (saved while offline) to the server.
        const localOnly = localMeta.filter(
          (m) => !serverMeta.some((s) => s.id === m.id)
        );
        if (localOnly.length > 0) serverPostMeta(localOnly);
      }

      const data: { messages?: ChatMessage[] } = await msgsRes.json();
      const serverMessages = Array.isArray(data.messages)
        ? data.messages
        : [];
      const local = getMessagesSnapshot();

      if (serverMessages.length === 0) {
        // Fresh database: push whatever exists locally (also covers the
        // legacy localStorage migration path) so it is never lost again.
        if (local.length > 0) serverPost(local);
        return;
      }

      // Union-merge by id: server content wins, but keep local-only messages
      // (written while offline) and locally cached audio clips.
      const byId = new Map<string, ChatMessage>();
      for (const m of local) byId.set(m.id, m);
      for (const m of serverMessages) {
        const existing = byId.get(m.id);
        byId.set(
          m.id,
          existing
            ? { ...m, audioBase64: existing.audioBase64 ?? m.audioBase64 }
            : m
        );
      }
      const merged = [...byId.values()].sort(
        (a, b) => a.createdAt - b.createdAt
      );
      const changed =
        merged.length !== local.length ||
        merged.some((m, i) => m !== local[i]);
      if (changed) {
        persist(merged);
        emit();
      }
    } catch (err) {
      console.error("🗄️ [store] Initial sync from server failed:", err);
    }
  })();
}

function serverPost(messages: ChatMessage[]): void {
  void fetch("/api/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  }).catch((err) => {
    console.error("🗄️ [store] Server save failed:", err);
  });
}

function serverDelete(sessionId?: string): void {
  const url = sessionId
    ? `/api/messages?sessionId=${encodeURIComponent(sessionId)}`
    : "/api/messages";
  void fetch(url, { method: "DELETE" }).catch((err) => {
    console.error("🗄️ [store] Server delete failed:", err);
  });
}

function serverPatchAudio(id: string, audioBase64: string): void {
  void fetch("/api/messages", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, audioBase64 }),
  }).catch((err) => {
    console.error("🗄️ [store] Server audio update failed:", err);
  });
}

/**
 * Persist grouped sessions. If localStorage is full, voice clips of the
 * OLDEST AI messages are dropped first (text/feedback always survive), then
 * retry.
 */
function persist(next: ChatMessage[]): void {
  let data = next;
  const write = (messages: ChatMessage[]): void => {
    const sessions = selectSessions(messages).map((s) => ({
      id: s.id,
      startedAt: s.startedAt,
      messages: s.messages,
    }));
    localStorage.setItem(
      sessionsKey(),
      JSON.stringify({ version: STORAGE_VERSION, sessions })
    );
  };

  for (;;) {
    try {
      write(data);
      cachedMessages = data;
      return;
    } catch (err) {
      const quotaError =
        err instanceof DOMException &&
        (err.name === "QuotaExceededError" || err.code === 22);
      if (!quotaError) {
        // Still keep in-memory state consistent even if writing failed.
        cachedMessages = data;
        console.error("💾 [store] Failed to persist sessions:", err);
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
      localStorage.setItem(pendingKey(), "1");
    } else {
      localStorage.removeItem(pendingKey());
    }
  } catch (err) {
    console.error("💾 [store] Failed to update session flag:", err);
  }
}

/**
 * Drop all in-memory caches and re-sync for the now-current user.
 * Called on login/logout/registration — existing subscribers stay
 * subscribed, so the initial server sync is re-triggered directly.
 */
export function resetForUserChange(): void {
  cachedMessages = null;
  cachedPending = null;
  cachedMeta = null;
  syncStarted = false;
  emit();
  if (typeof window !== "undefined") serverSync();
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
  serverPost([user, ai]);
  // Tag free-chat sessions with the accent used so History can show the flag.
  // Latest selection wins (changing accent takes effect on the next message).
  if (input.accent) {
    saveSessionMeta({
      id: sessionId,
      type: "chat",
      accent: input.accent,
      updatedAt: now,
    });
  }
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
  serverPost([notice]);
}

/**
 * Merge externally-created messages (e.g. lesson exchanges that keep their
 * own in-lesson transcript) into the canonical store so they appear in
 * history and stats. De-duplicates by id.
 */
export function ingestExternalMessages(incoming: ChatMessage[]): void {
  if (incoming.length === 0) return;
  const valid = incoming.filter(isValidMessage);
  if (valid.length === 0) return;
  const existing = getMessagesSnapshot();
  const known = new Set(existing.map((m) => m.id));
  const fresh = valid.filter((m) => !known.has(m.id));
  if (fresh.length === 0) return;
  const merged = [...existing, ...fresh].sort((a, b) => a.createdAt - b.createdAt);
  persist(merged);
  emit();
  serverPost(fresh);
}

export function beginNewSession(): void {
  markPending(true);
  emit();
}

export function clearAllMessages(): void {
  persist([]);
  persistMeta([]);
  markPending(false);
  emit();
  serverDelete();
  serverDeleteMeta();
}

export function deleteSession(sessionId: string): void {
  persist(
    getMessagesSnapshot().filter((m) => m.sessionId !== sessionId)
  );
  persistMeta(getMetaSnapshot().filter((m) => m.id !== sessionId));
  emit();
  serverDelete(sessionId);
  serverDeleteMeta(sessionId);
}

/** Cache a lazily re-fetched voice clip back onto its message. */
export function setMessageAudio(id: string, audioBase64: string): void {
  persist(
    getMessagesSnapshot().map((m) =>
      m.id === id ? { ...m, audioBase64 } : m
    )
  );
  emit();
  serverPatchAudio(id, audioBase64);
}

/** Group the flat message list into sessions, oldest first, merging metadata. */
export function selectSessions(messages: ChatMessage[]): Session[] {
  const metaById = new Map(getMetaSnapshot().map((m) => [m.id, m]));
  const sessions: Session[] = [];
  for (const message of messages) {
    const current = sessions[sessions.length - 1];
    if (current && current.id === message.sessionId) {
      current.messages.push(message);
    } else {
      const meta = metaById.get(message.sessionId);
      sessions.push({
        id: message.sessionId,
        startedAt: message.createdAt,
        messages: [message],
        // Backward compatibility: sessions without metadata are chats.
        type: meta?.type ?? "chat",
        ...(meta?.lessonId !== undefined
          ? { lessonId: meta.lessonId }
          : {}),
        ...(meta?.lessonTitle !== undefined
          ? { lessonTitle: meta.lessonTitle }
          : {}),
        ...(meta?.durationMinutes !== undefined
          ? { durationMinutes: meta.durationMinutes }
          : {}),
        ...(meta?.completedSteps !== undefined
          ? { completedSteps: meta.completedSteps }
          : {}),
        ...(meta?.totalSteps !== undefined
          ? { totalSteps: meta.totalSteps }
          : {}),
        ...(meta?.starsEarned !== undefined
          ? { starsEarned: meta.starsEarned }
          : {}),
        ...(meta?.correctionsCount !== undefined
          ? { correctionsCount: meta.correctionsCount }
          : {}),
        ...(meta?.timedOut !== undefined
          ? { timedOut: meta.timedOut }
          : {}),
        ...(meta?.accent !== undefined ? { accent: meta.accent } : {}),
      });
    }
  }
  return sessions;
}

/**
 * The chat tab shows the latest CHAT session — lesson sessions live in their
 * own mode and must never leak into the chat transcript.
 */
export function lastChatSessionId(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const sid = messages[i].sessionId;
    const meta = getMetaSnapshot().find((m) => m.id === sid);
    if ((meta?.type ?? "chat") === "chat") return sid;
  }
  return null;
}
