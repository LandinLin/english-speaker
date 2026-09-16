/**
 * The currently logged-in user's id, used to suffix every per-user
 * localStorage / IndexedDB key. Persisted so an offline reload boots
 * straight into the right data scope.
 *
 * Isomorphic module (no "use client"): also imported from server-shared
 * modules such as lessonPlan.ts; every storage access is window-guarded.
 */

const SCOPE_KEY = "english-buddy:user-scope";

let currentId: string | null | undefined = undefined;

export function getCurrentUserId(): string | null {
  if (currentId === undefined) {
    currentId =
      typeof window === "undefined"
        ? null
        : window.localStorage.getItem(SCOPE_KEY);
  }
  return currentId;
}

export function setCurrentUserId(id: string | null): void {
  currentId = id;
  if (typeof window === "undefined") return;
  try {
    if (id) {
      window.localStorage.setItem(SCOPE_KEY, id);
    } else {
      window.localStorage.removeItem(SCOPE_KEY);
    }
  } catch {
    // ignore storage failures
  }
}

/** Per-user storage key, e.g. "english-buddy:sessions:<uuid>". */
export function scopedKey(base: string): string {
  const id = getCurrentUserId();
  return id ? `${base}:${id}` : `${base}:none`;
}
