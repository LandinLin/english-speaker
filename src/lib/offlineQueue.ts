"use client";

/**
 * Outbox for voice messages recorded while offline.
 * Audio blobs live in IndexedDB (localStorage can't hold Blobs) and are
 * drained to /api/conversation by <OfflineQueueDrain/> when connectivity
 * returns. The database is scoped per logged-in user.
 */

import { getCurrentUserId } from "./userScope";

export interface QueuedExchange {
  id?: number;
  audio: Blob;
  history: { role: "user" | "assistant"; content: string }[];
  /** Teacher accent id ("us" | "uk" | "au" | "in"). */
  accent?: string;
  queuedAt: number;
}

const DB_NAME_BASE = "english-buddy-offline";
const STORE = "queue";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function dbName(): string {
  const userId = getCurrentUserId();
  return `${DB_NAME_BASE}:${userId ?? "none"}`;
}

/** Close and forget the current connection (called on login/logout). */
export function resetOfflineQueue(): void {
  if (dbPromise) {
    dbPromise.then((db) => db.close()).catch(() => {});
    dbPromise = null;
  }
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName(), DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

export async function enqueueExchange(
  audio: Blob,
  history: QueuedExchange["history"],
  accent?: string
): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({
      audio,
      history,
      ...(accent ? { accent } : {}),
      queuedAt: Date.now(),
    } satisfies Omit<QueuedExchange, "id">);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getQueuedExchanges(): Promise<QueuedExchange[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).getAll();
    request.onsuccess = () =>
      resolve((request.result as QueuedExchange[]).sort((a, b) => {
        const ida = a.id ?? 0;
        const idb = b.id ?? 0;
        return ida - idb;
      }));
    request.onerror = () => reject(request.error);
  });
}

export async function removeQueuedExchange(id: number): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getQueueCount(): Promise<number> {
  try {
    const items = await getQueuedExchanges();
    return items.length;
  } catch {
    return 0;
  }
}
