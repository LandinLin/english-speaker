import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import {
  createAuthSession,
  deleteAuthSession,
  getSessionUser,
  type SessionUser,
} from "./db";

export const SESSION_COOKIE = "eb_session";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const KEY_LEN = 64;

// ---------------------------------------------------------------------------
// Password hashing (scrypt, built into Node — no extra dependencies)
// ---------------------------------------------------------------------------

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, KEY_LEN).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, hashHex] = parts;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// ---------------------------------------------------------------------------
// Session tokens + cookies
// ---------------------------------------------------------------------------

export function generateSessionToken(): string {
  return randomBytes(32).toString("hex");
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    path: "/",
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_SECONDS,
  };
}

/** Create a session row and set the auth cookie (call from a route handler). */
export async function startSession(userId: string): Promise<string> {
  const token = generateSessionToken();
  createAuthSession(userId, token);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, sessionCookieOptions());
  return token;
}

/** Clear the session row and cookie on logout. */
export async function endSession(token: string | undefined): Promise<void> {
  if (token) deleteAuthSession(token);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, "", { ...sessionCookieOptions(), maxAge: 0 });
}

export async function getTokenFromCookies(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

/** Route-handler helper: the logged-in user or null. */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const token = await getTokenFromCookies();
  if (!token) return null;
  return getSessionUser(token);
}

/** Variant usable from proxy.ts (Next 16, Node runtime) with a raw cookie string. */
export function getUserFromCookieHeader(
  cookieHeader: string | null
): SessionUser | null {
  if (!cookieHeader) return null;
  const match = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (!match) return null;
  const token = decodeURIComponent(match.slice(SESSION_COOKIE.length + 1));
  if (!token) return null;
  return getSessionUser(token);
}
