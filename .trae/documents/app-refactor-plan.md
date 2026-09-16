# App Refactor: Bottom Tabs + Auth + Clean UI

## Context

The app grew organically: everything lives in `src/app/page.tsx` (chat, lesson toggle, video-call button, header pills), all data is single-user (SQLite `messages` table has no `user_id`; localStorage keys are global), and the UI is a stack of pill buttons. This refactor adds a bottom tab bar (Chat / Lesson / Video / Me), signup/login with per-user data, and a clean UI.

Executed in **two phases** — Phase 1 (bottom nav + UI) is shown to the user before Phase 2 (auth) starts.

## Progress status (2026-09-15)

**Phase 1 done:** `BottomNav.tsx` (4 tabs, safe-area), `(tabs)/layout.tsx` (`h-screen` + safe-area per adjustment 0), `(tabs)/page.tsx` (slim chat), `(tabs)/me/page.tsx`, `(tabs)/lesson/page.tsx`, `(tabs)/video/page.tsx`.

**Phase 1 remaining (this session):**
1. Delete `src/app/page.tsx` — still exists and **conflicts** with `(tabs)/page.tsx` (both resolve to `/`).
2. `LessonMode.tsx` bottom controls still `fixed bottom-0` → convert to in-flow flex footer.
3. `DigitalHumanCall.tsx` still `fixed inset-0 z-[60]` overlay → convert to in-flow flex layout.
4. `(tabs)/page.tsx` record button still `fixed bottom-24` → in-flow flex footer above nav.
5. Move `src/app/history` + `src/app/dashboard` INTO `(tabs)` (BottomNav stays visible; strip sticky back-headers; `min-h-dvh` → `h-full`). URLs unchanged.
6. `globals.css` — remove dark-mode override, keep light theme.
7. `(tabs)/layout.tsx` viewport height: keep `h-screen` (100vh) as fallback and add progressive enhancement via globals.css utility: `@supports (height: 100dvh) { height: 100dvh }` — approved addition for iOS Safari with visible URL bar.
8. Verify: `tsc --noEmit`, `eslint`, `next build`, `curl localhost:3000/` (adjustment 0), browser test 4 tabs + screenshot. **Show user before Phase 2.**

## User-approved adjustments (apply throughout)

0. **Phase-1 additions (approved after plan review):**
   - Use `h-screen` + safe-area padding instead of `h-dvh` (broader iOS Safari compatibility).
   - After deleting `src/app/page.tsx`, verify `curl localhost:3000/` returns the chat page (not 404).
   - `adoptOrphanMessages` runs ONLY during first-user registration; log a warning if orphan rows appear later (Phase 2).
   - `authRateLimit.ts`: purge entries older than 15 min on every check; cap Map at 10,000 entries (Phase 2).
   - Explicitly test `/lesson` + `/video` redirects to `/login` while logged out (Phase 2).
1. Password minimum **8 chars**, friendly hint in the form.
2. Username allows `a-z`, `0-9`, `_`, `-`, **and Chinese characters** — regex `^[\p{L}\p{N}_-]{2,20}$` (`u` flag).
3. **Rate-limit** `/api/auth/login`: 5 attempts per IP per 15 min (in-memory Map, no deps).
4. Cookie: `httpOnly`, **`sameSite=lax`**, **`secure` in production**, `path=/`, `Max-Age=30d` (persistent cookie — required for Safari iOS to keep it).
5. Client **logout** clears: `english-buddy:auth-user`, userScope (set to null), and the message cache (via `resetForUserChange()`).
6. + 10. **DB migration safety**: back up `data/english-buddy.db` → `data/english-buddy.backup-<timestamp>.db` first, then run DDL **inside a better-sqlite3 transaction with rollback on failure**, and log the result.
7. **Test Safari iOS cookie persistence + PWA install**: verify cookie survives reloads (persistent Max-Age), SW/manifest still register; document that PWA install requires HTTPS (localhost is fine in dev).
8. **`/lesson` and `/video` live INSIDE the `(tabs)` group** so BottomNav stays visible; LessonMode and DigitalHumanCall are refactored from fixed-position chrome to flex flow sitting above the nav.
9. **AuthGate never wraps auth pages**: real routes `/login` and `/register` exist; AuthGate checks `usePathname()` and passes them through (and redirects to `/` if already logged in). `/api/auth/*` are route handlers — never gated.

---

## PHASE 1 — Bottom nav + clean UI (show result first)

### New files
| File | Purpose |
|---|---|
| `src/components/BottomNav.tsx` | Fixed bottom bar: 💬 Chat `/` · 📚 Lesson `/lesson` · 📹 Video `/video` · 👤 Me `/me`. Active via `usePathname`, safe-area padding, white + blur + top border. |
| `src/app/(tabs)/layout.tsx` | `flex h-dvh flex-col`; children in flex-1 with bottom padding for the nav; renders `<BottomNav/>`. |
| `src/app/(tabs)/page.tsx` | Chat tab — moved from `app/page.tsx`, slimmed: header = buddy emoji + title + small "New chat" icon; transcript + record button logic unchanged. |
| `src/app/(tabs)/me/page.tsx` | Me tab: profile header (avatar, name placeholder, 🔥 streak + 🏆 badge chips via `computeStats` + `countEarnedBadges`), menu list → `/history`, `/dashboard`; logout button appears in Phase 2. |
| `src/app/(tabs)/lesson/page.tsx` | Wraps `<LessonMode onExit={() => router.push("/")} />`. |
| `src/app/(tabs)/video/page.tsx` | Wraps `<DigitalHumanCall open onClose={() => router.push("/")} />`. |

### Modified files
- **`src/components/LessonMode.tsx`** — fixed bottom controls → flex flow (root is already `flex h-full flex-col`); bottom padding for nav; keep all timer/gating logic.
- **`src/components/DigitalHumanCall.tsx`** — fixed fullscreen overlay → inline flex layout (header / video flex-1 / controls in flow, above nav); keep `open`/`onClose` props and WebRTC logic.
- **Delete `src/app/page.tsx`** (moved to `(tabs)/page.tsx`).
- **`src/app/globals.css`** — remove dark-mode override; Geist font on body; neutral background token.

### UI direction
Neutral `#f7f8fa` background, white `rounded-2xl` cards with `shadow-sm`, single blue accent (#3b82f6), celebratory colors only in lesson/celebration screens, buttons ≥44px, no header pill clutter.

### Phase 1 verification
`tsc --noEmit && npm run lint && npm run build` clean; browser test: 4 tabs navigate, chat works end-to-end (voice), lesson timer/gating renders above nav, video call UI inline with nav, Me page shows streak/badges, History/Dashboard still work. **Show the user before Phase 2.**

---

## PHASE 2 — Auth + per-user data

### New files
| File | Purpose |
|---|---|
| `src/lib/auth.ts` | Server: scrypt `hashPassword`/`verifyPassword`, session create/get/delete, `getUserFromRequest(request)` (parses cookie header). Cookie options per adjustment #4. |
| `src/lib/authRateLimit.ts` | In-memory sliding window: 5 login attempts / IP / 15 min (#3). |
| `src/lib/userScope.ts` | Client: `getCurrentUserId()` / `setCurrentUserId(id)` for localStorage key suffixing. |
| `src/lib/authStore.ts` | Client store (useSyncExternalStore, module-level named snapshots): `useAuth()`, `login()`, `register()`, `logout()` (per adjustment #5). Caches last user in `english-buddy:auth-user` for offline boot. On user change: sets userScope → `messageStore.resetForUserChange()`. |
| `src/components/AuthGate.tsx` | Client, in root layout: passes through `/login` + `/register` (#9); splash while loading; redirects to `/login` when logged out; redirects to `/` when logged in on auth pages. |
| `src/proxy.ts` | **Next 16 convention** (`middleware.ts` is deprecated in 16.3.5 — bundled docs confirm `proxy.ts` + exported `proxy()`). Server-side guard for tab pages (`/`, `/lesson`, `/video`, `/me`, `/history`, `/dashboard`): **full session lookup** against `auth_sessions` (local better-sqlite3 PK lookup is sub-ms — well under the approved 10 ms budget) — no/expired token → 302 `/login` **and clear the stale cookie**; logged in on `/login`/`/register` → `/`. DB errors fall back to cookie-presence check so pages never hard-fail. Matcher excludes `/api`, `_next/static`, `_next/image`, `sw.js`, `manifest.json`, icons. Makes adjustment 0's `/lesson`+`/video` redirect explicitly curl-testable. |
| `src/components/AuthForm.tsx` | Shared form: mode login/register, username rules (#2) + password ≥8 with friendly hint (#1), kid-friendly styling, error display. |
| `src/app/(auth)/login/page.tsx` | Login page (not wrapped by tabs layout). |
| `src/app/(auth)/register/page.tsx` | Register page. |
| `src/app/api/auth/register/route.ts` | Validate (#1 #2), create user, **adopt orphan messages** (user_id NULL → first user), set cookie. |
| `src/app/api/auth/login/route.ts` | Rate-limit (#3), verify hash, set cookie. 401 on bad creds. |
| `src/app/api/auth/logout/route.ts` | Delete session, clear cookie. |
| `src/app/api/auth/me/route.ts` | `{user}` or `{user:null}` from cookie. |

### Modified files
- **`src/lib/db.ts`** — backup + transactional migration (#6 #10): `users` table (id, username UNIQUE, display_name, password_hash, created_at), `auth_sessions` (token PK, user_id, expires_at), `ALTER TABLE messages ADD COLUMN user_id TEXT` + index — all inside `db.transaction()` with rollback, after copying the DB file; log each step. All message queries become user-scoped; add `adoptOrphanMessages(userId)` — runs ONLY when the users table was empty before this registration (adjustment 0); on later registrations it only SELECTs the orphan count and `console.warn`s if rows exist, without adopting.
- **`src/app/api/messages/route.ts`** — 401 without session; user-scoped GET/POST/PATCH/DELETE; POST ignores client-sent user.
- **`src/lib/messageStore.ts`** — keys suffixed `:<userId>` at call time; export `resetForUserChange()` (clear module caches, `syncStarted=false`, direct `serverSync()`, emit — existing subscribers never re-subscribe so this must re-trigger sync).
- **`src/lib/badgeStorage.ts` + `src/lib/lessonPlan.ts`** — keys via `scopedKey(base)` (no caches; reads happen per call).
- **`src/app/layout.tsx`** — wrap children in `<AuthGate>`.
- **`(tabs)/me/page.tsx`** — show username from `useAuth()`; add logout button (adjustment #5).
- **`(tabs)/history/page.tsx` + `(tabs)/dashboard/page.tsx`** — moved into `(tabs)` during Phase 1; in Phase 2 they simply inherit session-scoped data (no code change beyond what Phase 1 did).

### Phase 2 verification
1. Builds clean. 2. Register A → chat → logout → register B → B sees empty history; login A → A's data back. 3. Legacy rows adopted by first registered account (check `data/english-buddy.backup-*.db` exists + migration log). 4. `curl /api/messages` without cookie → 401; 6th login attempt within 15 min → 429. 5. Cookie persists across reload (Safari check per #7), SW + manifest intact. 6. Offline: cached user boots app, queue still drains. 7. **Explicit redirect test (adjustment 0): logged out, `curl -sI localhost:3000/lesson` and `/video` → 302 to `/login`; logged in → 200.**
