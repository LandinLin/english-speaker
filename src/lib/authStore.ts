"use client";

import { useEffect, useSyncExternalStore } from "react";
import { setCurrentUserId } from "./userScope";
import { resetForUserChange } from "./messageStore";
import { resetOfflineQueue } from "./offlineQueue";
import { resetAccentPreference } from "./accentStore";

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
}

export type AuthStatus = "loading" | "authed" | "guest";

export interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
}

const AUTH_USER_KEY = "english-buddy:auth-user";

function readCachedUser(): AuthUser | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(AUTH_USER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthUser;
    return parsed && typeof parsed.id === "string" ? parsed : null;
  } catch {
    return null;
  }
}

let state: AuthState = {
  status: "loading",
  // Cached user allows an instant offline/authenticated-looking boot;
  // /api/auth/me confirms it below.
  user: typeof window === "undefined" ? null : readCachedUser(),
};

const listeners = new Set<() => void>();

function setState(next: AuthState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): AuthState {
  return state;
}

function applyUserChange(user: AuthUser | null): void {
  try {
    if (user) {
      window.localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
    } else {
      window.localStorage.removeItem(AUTH_USER_KEY);
    }
  } catch {
    // ignore
  }
  setCurrentUserId(user ? user.id : null);
  resetOfflineQueue();
  resetAccentPreference();
  resetForUserChange();
  setState(user ? { status: "authed", user } : { status: "guest", user: null });
}

let bootStarted = false;

/** Confirm the cached session with the server; idempotent. */
export function bootAuth(): void {
  if (bootStarted || typeof window === "undefined") return;
  bootStarted = true;

  const cached = readCachedUser();

  void (async () => {
    try {
      const res = await fetch("/api/auth/me", { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as
        | { user: AuthUser | null }
        | null;
      const user = data?.user ?? null;

      if (user) {
        const scopeChanged = cached?.id !== user.id;
        try {
          window.localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
        } catch {
          // ignore
        }
        setCurrentUserId(user.id);
        setState({ status: "authed", user });
        // Scope may differ from the offline cache — reload that user's data.
        if (scopeChanged) {
          resetOfflineQueue();
          resetAccentPreference();
          resetForUserChange();
        }
      } else {
        applyUserChange(null);
      }
    } catch {
      // Offline: trust the cached user; otherwise show the auth screen.
      if (cached) {
        setCurrentUserId(cached.id);
        setState({ status: "authed", user: cached });
      } else {
        setState({ status: "guest", user: null });
      }
    }
  })();
}

export function useAuth(): AuthState {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    bootAuth();
  }, []);
  return snapshot;
}

async function postCredentials(
  endpoint: "/api/auth/login" | "/api/auth/register",
  username: string,
  password: string
): Promise<AuthUser> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = (await res.json().catch(() => null)) as
    | { user?: AuthUser; error?: string }
    | null;
  if (!res.ok || !data?.user) {
    throw new Error(data?.error || "Something went wrong. Please try again!");
  }
  return data.user;
}

export async function login(username: string, password: string): Promise<void> {
  const user = await postCredentials("/api/auth/login", username, password);
  applyUserChange(user);
}

/**
 * Creates the account but does NOT sign in. The caller should navigate to
 * /login so the user signs in manually (no session cookie is issued at
 * registration).
 */
export async function register(
  username: string,
  password: string
): Promise<void> {
  await postCredentials("/api/auth/register", username, password);
}

export async function logout(): Promise<void> {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch {
    // Local logout happens even if the network call fails.
  }
  applyUserChange(null);
}
