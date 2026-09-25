import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/lib/db";

// Keep in sync with SESSION_COOKIE in src/lib/auth.ts (duplicated on purpose —
// proxy must not pull in next/headers).
const SESSION_COOKIE = "eb_session";
const AUTH_PAGES = new Set(["/login", "/register"]);
const PROTECTED_PAGES = new Set([
  "/",
  "/lesson",
  "/call",
  "/me",
  "/history",
  "/dashboard",
]);

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isAuthPage = AUTH_PAGES.has(pathname);

  // Unknown paths (assets, etc. already excluded by matcher) pass through.
  if (!isAuthPage && !PROTECTED_PAGES.has(pathname)) {
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;

  // Full validation: Postgres indexed primary-key lookup.
  let validUser = false;
  try {
    validUser = token ? (await getSessionUser(token)) !== null : false;
  } catch (error) {
    // Never hard-fail a page on a lookup error — fall back to cookie presence;
    // the client AuthGate and the API handlers enforce the real session.
    console.warn("🛡️ [proxy] Session lookup failed, using cookie presence:", error);
    validUser = Boolean(token);
  }

  if (validUser) {
    if (isAuthPage) {
      return NextResponse.redirect(new URL("/", request.url));
    }
    return NextResponse.next();
  }

  if (isAuthPage) {
    return NextResponse.next();
  }

  // Logged out (or stale/expired cookie) → login; clear the dead cookie.
  const response = NextResponse.redirect(new URL("/login", request.url));
  if (token) {
    response.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  }
  return response;
}

export const config = {
  matcher: [
    // App pages only — APIs authenticate themselves; skip Next internals
    // and static/PWA assets.
    "/((?!api|_next/static|_next/image|favicon.ico|manifest.json|sw.js|icon-|apple-touch|.*\\.(?:png|jpg|jpeg|svg|webp|ico|gif)$).*)",
  ],
};
