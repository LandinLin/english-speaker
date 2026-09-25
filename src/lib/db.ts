import { Pool, type QueryConfig, type QueryResultRow } from "pg";

export interface StoredMessage {
  id: string;
  sessionId: string;
  createdAt: number;
  role: "user" | "ai";
  text: string;
  praise?: string;
  correction?: string;
  newWord?: string;
  audioBase64?: string;
}

export interface StoredUser {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  createdAt: number;
}

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
}

/** Session-level metadata. Sessions without a row default to type 'chat'. */
export interface StoredSessionMeta {
  id: string;
  type: "chat" | "lesson" | "call";
  lessonId?: string;
  lessonTitle?: string;
  durationMinutes?: number;
  completedSteps?: number;
  totalSteps?: number;
  starsEarned?: number;
  correctionsCount?: number;
  /** True when the 10-minute timer expired before the lesson finished. */
  timedOut?: boolean;
  /** Teacher accent used in this session ("us" | "uk" | "au" | "in"). */
  accent?: string;
  /** Human-readable session title (used for voice calls). */
  title?: string;
  /** Voice-call lifecycle timestamps / duration. */
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  updatedAt: number;
}

interface SessionMetaRow {
  id: string;
  user_id: string;
  type: string;
  lesson_id: string | null;
  lesson_title: string | null;
  duration_minutes: number | null;
  completed_steps: number | null;
  total_steps: number | null;
  stars_earned: number | null;
  corrections_count: number | null;
  timed_out: boolean | null;
  accent: string | null;
  title: string | null;
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number | null;
  updated_at: number;
}

interface MessageRow {
  id: string;
  session_id: string;
  created_at: number;
  role: string;
  text: string;
  praise: string | null;
  correction: string | null;
  new_word: string | null;
  audio_base64: string | null;
  user_id: string | null;
}

interface StoredUserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Connection pool. Survives Next.js dev hot-reloads via globalThis.
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;
const connectionString =
  process.env.DATABASE_URL ??
  "postgresql://127.0.0.1:5432/english_buddy";

type PoolGlobal = { __pgPool?: Pool; __pgInit?: Promise<void> };
const globalForPool = globalThis as unknown as PoolGlobal;

function createPool(): Pool {
  const isLocal = /@(?:localhost|127\.0\.0\.1)(?::|\/)/.test(connectionString);
  const pool = new Pool({
    connectionString,
    // Managed Postgres (Neon/Supabase/...) requires TLS; local sockets do not.
    ssl: isLocal ? undefined : { rejectUnauthorized: false },
  });
  pool.on("error", (err) => {
    console.error("🗄️ [db] Unexpected idle Postgres client error:", err);
  });
  return pool;
}

function getPool(): Pool {
  if (!globalForPool.__pgPool) globalForPool.__pgPool = createPool();
  return globalForPool.__pgPool;
}

// ---------------------------------------------------------------------------
// Schema (idempotent). Bump SCHEMA_VERSION and add migration steps below when
// the shape changes; app_meta records the version the cluster was built at.
// ---------------------------------------------------------------------------

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_key
  ON users (lower(username));

CREATE TABLE IF NOT EXISTS auth_sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'ai')),
  text TEXT NOT NULL,
  praise TEXT,
  correction TEXT,
  new_word TEXT,
  audio_base64 TEXT,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_user_session ON messages(user_id, session_id);

CREATE TABLE IF NOT EXISTS session_meta (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'chat' CHECK (type IN ('chat', 'lesson', 'call')),
  lesson_id TEXT,
  lesson_title TEXT,
  duration_minutes INTEGER,
  completed_steps INTEGER,
  total_steps INTEGER,
  stars_earned INTEGER,
  corrections_count INTEGER,
  timed_out BOOLEAN NOT NULL DEFAULT false,
  accent TEXT,
  title TEXT,
  started_at BIGINT,
  ended_at BIGINT,
  duration_ms BIGINT,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_meta_user ON session_meta(user_id);

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO app_meta (key, value)
VALUES ('schema_version', '${SCHEMA_VERSION}')
ON CONFLICT (key) DO NOTHING;
`;

async function init(): Promise<void> {
  if (!globalForPool.__pgInit) {
    globalForPool.__pgInit = (async () => {
      await getPool().query(SCHEMA_DDL);
      console.log("🗄️ [db] Postgres schema ready");
    })();
  }
  return globalForPool.__pgInit;
}

async function query<T extends QueryResultRow>(
  text: QueryConfig | string,
  params?: unknown[]
): Promise<T[]> {
  await init();
  const result = await getPool().query(text, params);
  return result.rows as T[];
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export async function createUser(input: {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
}): Promise<StoredUser> {
  await query(
    `INSERT INTO users (id, username, display_name, password_hash, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      input.id,
      input.username,
      input.displayName,
      input.passwordHash,
      Date.now(),
    ]
  );
  const user = await getUserById(input.id);
  if (!user) throw new Error(`createUser: row ${input.id} missing after insert`);
  return user;
}

export async function getUserById(id: string): Promise<StoredUser | null> {
  const rows = await query<StoredUserRow>(
    "SELECT * FROM users WHERE id = $1",
    [id]
  );
  return rows[0] ? rowToUser(rows[0]) : null;
}

export async function getUserByUsername(
  username: string
): Promise<StoredUser | null> {
  // Matches the old SQLite COLLATE NOCASE behaviour (usernames are ASCII per
  // validation), backed by the lower(username) unique index.
  const rows = await query<StoredUserRow>(
    "SELECT * FROM users WHERE lower(username) = lower($1)",
    [username]
  );
  return rows[0] ? rowToUser(rows[0]) : null;
}

export async function countUsers(): Promise<number> {
  const rows = await query<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM users"
  );
  return rows[0].count;
}

function rowToUser(row: StoredUserRow): StoredUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    createdAt: Number(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// Auth sessions
// ---------------------------------------------------------------------------

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function createAuthSession(
  userId: string,
  token: string,
  now = Date.now()
): Promise<void> {
  await query(
    "INSERT INTO auth_sessions (token, user_id, expires_at) VALUES ($1, $2, $3)",
    [token, userId, now + SESSION_TTL_MS]
  );
}

/** Returns the session's user when the token is valid and unexpired. */
export async function getSessionUser(
  token: string,
  now = Date.now()
): Promise<SessionUser | null> {
  const rows = await query<SessionUser>(
    `SELECT u.id AS id, u.username AS username, u.display_name AS display_name
     FROM auth_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > $2`,
    [token, now]
  );
  return rows[0] ?? null;
}

export async function deleteAuthSession(token: string): Promise<void> {
  await query("DELETE FROM auth_sessions WHERE token = $1", [token]);
}

export async function deleteExpiredSessions(now = Date.now()): Promise<void> {
  await query("DELETE FROM auth_sessions WHERE expires_at <= $1", [now]);
}

// ---------------------------------------------------------------------------
// Messages (user-scoped)
// ---------------------------------------------------------------------------

function rowToMessage(row: MessageRow, withAudio: boolean): StoredMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    createdAt: Number(row.created_at),
    role: row.role === "user" ? "user" : "ai",
    text: row.text,
    ...(row.praise !== null ? { praise: row.praise } : {}),
    ...(row.correction !== null ? { correction: row.correction } : {}),
    ...(row.new_word !== null ? { newWord: row.new_word } : {}),
    ...(withAudio && row.audio_base64 !== null
      ? { audioBase64: row.audio_base64 }
      : {}),
  };
}

/** All messages for a user, oldest first. Audio excluded to keep payloads light. */
export async function listMessages(
  userId: string
): Promise<StoredMessage[]> {
  const rows = await query<MessageRow>(
    `SELECT id, session_id, created_at, role, text, praise, correction, new_word, audio_base64, user_id
     FROM messages WHERE user_id = $1 ORDER BY created_at ASC`,
    [userId]
  );
  return rows.map((row) => rowToMessage(row, false));
}

/** Upsert messages for a user. Existing audio is kept when the incoming copy has none. */
export async function upsertMessages(
  userId: string,
  messages: StoredMessage[]
): Promise<number> {
  if (messages.length === 0) return 0;
  await init();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // One set-based INSERT via unnest keeps this a single round trip while
    // preserving the ON CONFLICT audio-merge semantics of the old store.
    await client.query(
      `INSERT INTO messages (
         id, session_id, created_at, role, text, praise, correction,
         new_word, audio_base64, user_id
       )
       SELECT * FROM unnest(
         $1::text[], $2::text[], $3::bigint[], $4::text[], $5::text[],
         $6::text[], $7::text[], $8::text[], $9::text[], $10::text[]
       )
       ON CONFLICT (id) DO UPDATE SET
         session_id = excluded.session_id,
         created_at = excluded.created_at,
         role = excluded.role,
         text = excluded.text,
         praise = excluded.praise,
         correction = excluded.correction,
         new_word = excluded.new_word,
         audio_base64 = COALESCE(excluded.audio_base64, messages.audio_base64),
         user_id = COALESCE(excluded.user_id, messages.user_id)`,
      [
        messages.map((m) => m.id),
        messages.map((m) => m.sessionId),
        messages.map((m) => String(m.createdAt)),
        messages.map((m) => m.role),
        messages.map((m) => m.text),
        messages.map((m) => m.praise ?? null),
        messages.map((m) => m.correction ?? null),
        messages.map((m) => m.newWord ?? null),
        messages.map((m) => m.audioBase64 ?? null),
        messages.map(() => userId),
      ]
    );
    await client.query("COMMIT");
    return messages.length;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteMessagesBySession(
  userId: string,
  sessionId: string
): Promise<number> {
  const rows = await query<{ deleted: number }>(
    `DELETE FROM messages WHERE user_id = $1 AND session_id = $2
     RETURNING 1::int AS deleted`,
    [userId, sessionId]
  );
  return rows.length;
}

export async function deleteAllMessages(userId: string): Promise<number> {
  const rows = await query<{ deleted: number }>(
    "DELETE FROM messages WHERE user_id = $1 RETURNING 1::int AS deleted",
    [userId]
  );
  return rows.length;
}

export async function updateMessageAudio(
  userId: string,
  id: string,
  audioBase64: string
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE messages SET audio_base64 = $1
     WHERE user_id = $2 AND id = $3 RETURNING id`,
    [audioBase64, userId, id]
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Orphan adoption — pre-auth messages (user_id NULL) belong to the FIRST
// registered user. Later registrations never adopt; stray rows only warn.
// ---------------------------------------------------------------------------

export async function countOrphanMessages(): Promise<number> {
  const rows = await query<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM messages WHERE user_id IS NULL"
  );
  return rows[0].count;
}

export async function adoptOrphanMessages(userId: string): Promise<number> {
  const rows = await query<{ id: string }>(
    "UPDATE messages SET user_id = $1 WHERE user_id IS NULL RETURNING id",
    [userId]
  );
  return rows.length;
}

// ---------------------------------------------------------------------------
// Session metadata (chat vs lesson, lesson results)
// ---------------------------------------------------------------------------

function rowToSessionMeta(row: SessionMetaRow): StoredSessionMeta {
  return {
    id: row.id,
    type:
      row.type === "lesson"
        ? "lesson"
        : row.type === "call"
          ? "call"
          : "chat",
    ...(row.lesson_id !== null ? { lessonId: row.lesson_id } : {}),
    ...(row.lesson_title !== null ? { lessonTitle: row.lesson_title } : {}),
    ...(row.duration_minutes !== null
      ? { durationMinutes: Number(row.duration_minutes) }
      : {}),
    ...(row.completed_steps !== null
      ? { completedSteps: Number(row.completed_steps) }
      : {}),
    ...(row.total_steps !== null ? { totalSteps: Number(row.total_steps) } : {}),
    ...(row.stars_earned !== null
      ? { starsEarned: Number(row.stars_earned) }
      : {}),
    ...(row.corrections_count !== null
      ? { correctionsCount: Number(row.corrections_count) }
      : {}),
    ...(row.timed_out === true ? { timedOut: true } : {}),
    ...(row.accent !== null ? { accent: row.accent } : {}),
    ...(row.title !== null ? { title: row.title } : {}),
    ...(row.started_at !== null ? { startedAt: Number(row.started_at) } : {}),
    ...(row.ended_at !== null ? { endedAt: Number(row.ended_at) } : {}),
    ...(row.duration_ms !== null ? { durationMs: Number(row.duration_ms) } : {}),
    updatedAt: Number(row.updated_at),
  };
}

/** All session metadata rows for a user, oldest first. */
export async function listSessionMeta(
  userId: string
): Promise<StoredSessionMeta[]> {
  const rows = await query<SessionMetaRow>(
    `SELECT id, user_id, type, lesson_id, lesson_title, duration_minutes,
            completed_steps, total_steps, stars_earned, corrections_count,
            timed_out, accent, title, started_at, ended_at, duration_ms,
            updated_at
     FROM session_meta WHERE user_id = $1 ORDER BY updated_at ASC`,
    [userId]
  );
  return rows.map(rowToSessionMeta);
}

/** Upsert one session-metadata row. */
export async function upsertSessionMeta(
  userId: string,
  meta: StoredSessionMeta
): Promise<void> {
  await query(
    `INSERT INTO session_meta (
       id, user_id, type, lesson_id, lesson_title, duration_minutes,
       completed_steps, total_steps, stars_earned, corrections_count,
       timed_out, accent, title, started_at, ended_at, duration_ms, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       $11, $12, $13, $14, $15, $16, $17
     )
     ON CONFLICT (id) DO UPDATE SET
       type = excluded.type,
       lesson_id = excluded.lesson_id,
       lesson_title = excluded.lesson_title,
       duration_minutes = excluded.duration_minutes,
       completed_steps = excluded.completed_steps,
       total_steps = excluded.total_steps,
       stars_earned = excluded.stars_earned,
       corrections_count = excluded.corrections_count,
       timed_out = excluded.timed_out,
       accent = excluded.accent,
       title = excluded.title,
       started_at = excluded.started_at,
       ended_at = excluded.ended_at,
       duration_ms = excluded.duration_ms,
       updated_at = excluded.updated_at`,
    [
      meta.id,
      userId,
      meta.type === "lesson" ? "lesson" : meta.type === "call" ? "call" : "chat",
      meta.lessonId ?? null,
      meta.lessonTitle ?? null,
      meta.durationMinutes ?? null,
      meta.completedSteps ?? null,
      meta.totalSteps ?? null,
      meta.starsEarned ?? null,
      meta.correctionsCount ?? null,
      meta.timedOut ? true : false,
      meta.accent ?? null,
      meta.title ?? null,
      meta.startedAt ?? null,
      meta.endedAt ?? null,
      meta.durationMs ?? null,
      meta.updatedAt,
    ]
  );
}

export async function deleteSessionMeta(
  userId: string,
  id: string
): Promise<number> {
  const rows = await query<{ deleted: number }>(
    `DELETE FROM session_meta WHERE user_id = $1 AND id = $2
     RETURNING 1::int AS deleted`,
    [userId, id]
  );
  return rows.length;
}

export async function deleteAllSessionMeta(userId: string): Promise<number> {
  const rows = await query<{ deleted: number }>(
    "DELETE FROM session_meta WHERE user_id = $1 RETURNING 1::int AS deleted",
    [userId]
  );
  return rows.length;
}
