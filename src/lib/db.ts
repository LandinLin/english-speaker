import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

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
  type: "chat" | "lesson";
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
  timed_out: number | null;
  accent: string | null;
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

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;

  const dataDir = path.join(process.cwd(), "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "english-buddy.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 3000");
  migrate(db, dbPath);
  return db;
}

// ---------------------------------------------------------------------------
// Migration. Each step upgrades PRAGMA user_version by one, backs up the
// database file first (when data exists), and runs its DDL inside a single
// transaction with rollback on failure.
//   v1 → v2: users + auth_sessions + messages.user_id
//   v2 → v3: session_meta (chat/lesson typing + lesson results)
//   v3 → v4: session_meta.accent (teacher voice used in the session)
// ---------------------------------------------------------------------------
function migrate(database: Database.Database, dbPath: string): void {
  let userVersion = database.pragma("user_version", { simple: true }) as number;
  if (userVersion >= 4) return;

  const backup = (targetVersion: number) => {
    if (!fs.existsSync(dbPath)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(
      path.dirname(dbPath),
      `english-buddy.backup-v${targetVersion}-${stamp}.db`
    );
    database.backup(backupPath);
    console.log(`🗄️ [db] Pre-v${targetVersion} backup created: ${backupPath}`);
  };

  // ── v1 → v2 ──────────────────────────────────────────────────────────
  if (userVersion < 2) {
    backup(2);
    const hasUserIdColumn = (
      database.prepare("PRAGMA table_info(messages)").all() as { name: string }[]
    ).some((col) => col.name === "user_id");

    const v2 = database.transaction(() => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS auth_sessions (
          token TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);
      `);
      if (!hasUserIdColumn) {
        database.exec(`
          ALTER TABLE messages ADD COLUMN user_id TEXT;
          CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
        `);
      }
      database.pragma("user_version = 2");
    });

    try {
      v2();
      userVersion = 2;
      console.log("✅ [db] Migration to v2 complete (users + sessions + user_id)");
    } catch (err) {
      console.error("❌ [db] v2 migration failed (rolled back):", err);
      throw err;
    }
  }

  // ── v2 → v3 ──────────────────────────────────────────────────────────
  if (userVersion < 3) {
    backup(3);
    const v3 = database.transaction(() => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS session_meta (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          type TEXT NOT NULL DEFAULT 'chat',
          lesson_id TEXT,
          lesson_title TEXT,
          duration_minutes INTEGER,
          completed_steps INTEGER,
          total_steps INTEGER,
          stars_earned INTEGER,
          corrections_count INTEGER,
          timed_out INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_session_meta_user ON session_meta(user_id);
      `);
      database.pragma("user_version = 3");
    });

    try {
      v3();
      console.log("✅ [db] Migration to v3 complete (session_meta)");
    } catch (err) {
      console.error("❌ [db] v3 migration failed (rolled back):", err);
      throw err;
    }
  }

  // ── v3 → v4 ──────────────────────────────────────────────────────────
  if (userVersion < 4) {
    backup(4);
    const v4 = database.transaction(() => {
      const hasAccentColumn = (
        database.prepare("PRAGMA table_info(session_meta)").all() as { name: string }[]
      ).some((col) => col.name === "accent");
      if (!hasAccentColumn) {
        database.exec(
          "ALTER TABLE session_meta ADD COLUMN accent TEXT"
        );
      }
      database.pragma("user_version = 4");
    });

    try {
      v4();
      console.log("✅ [db] Migration to v4 complete (session_meta.accent)");
    } catch (err) {
      console.error("❌ [db] v4 migration failed (rolled back):", err);
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export function createUser(input: {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
}): StoredUser {
  getDb()
    .prepare(
      `INSERT INTO users (id, username, display_name, password_hash, created_at)
       VALUES (@id, @username, @displayName, @passwordHash, @createdAt)`
    )
    .run({
      id: input.id,
      username: input.username,
      displayName: input.displayName,
      passwordHash: input.passwordHash,
      createdAt: Date.now(),
    });
  return getUserById(input.id)!;
}

export function getUserById(id: string): StoredUser | null {
  const row = getDb().prepare("SELECT * FROM users WHERE id = ?").get(id) as
    | StoredUserRow
    | undefined;
  return row ? rowToUser(row) : null;
}

export function getUserByUsername(username: string): StoredUser | null {
  const row = getDb()
    .prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE")
    .get(username) as StoredUserRow | undefined;
  return row ? rowToUser(row) : null;
}

export function countUsers(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM users").get() as {
    n: number;
  };
  return row.n;
}

interface StoredUserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  created_at: number;
}

function rowToUser(row: StoredUserRow): StoredUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Auth sessions
// ---------------------------------------------------------------------------

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function createAuthSession(
  userId: string,
  token: string,
  now = Date.now()
): void {
  getDb()
    .prepare(
      "INSERT INTO auth_sessions (token, user_id, expires_at) VALUES (?, ?, ?)"
    )
    .run(token, userId, now + SESSION_TTL_MS);
}

/** Returns the session's user when the token is valid and unexpired. */
export function getSessionUser(token: string, now = Date.now()): SessionUser | null {
  const row = getDb()
    .prepare(
      `SELECT u.id AS id, u.username AS username, u.display_name AS display_name
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`
    )
    .get(token, now) as SessionUser | undefined;
  return row ?? null;
}

export function deleteAuthSession(token: string): void {
  getDb().prepare("DELETE FROM auth_sessions WHERE token = ?").run(token);
}

export function deleteExpiredSessions(now = Date.now()): void {
  getDb().prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(now);
}

// ---------------------------------------------------------------------------
// Messages (user-scoped)
// ---------------------------------------------------------------------------

function rowToMessage(row: MessageRow, withAudio: boolean): StoredMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    createdAt: row.created_at,
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
export function listMessages(userId: string): StoredMessage[] {
  const rows = getDb()
    .prepare(
      `SELECT id, session_id, created_at, role, text, praise, correction, new_word, audio_base64, user_id
       FROM messages WHERE user_id = ? ORDER BY created_at ASC`
    )
    .all(userId) as MessageRow[];
  return rows.map((row) => rowToMessage(row, false));
}

function toBind(message: StoredMessage, userId: string) {
  return {
    id: message.id,
    sessionId: message.sessionId,
    createdAt: message.createdAt,
    role: message.role,
    text: message.text,
    praise: message.praise ?? null,
    correction: message.correction ?? null,
    newWord: message.newWord ?? null,
    audioBase64: message.audioBase64 ?? null,
    userId,
  };
}

/** Upsert messages for a user. Existing audio is kept when the incoming copy has none. */
export function upsertMessages(
  userId: string,
  messages: StoredMessage[]
): number {
  const stmt = getDb().prepare(`
    INSERT INTO messages (id, session_id, created_at, role, text, praise, correction, new_word, audio_base64, user_id)
    VALUES (@id, @sessionId, @createdAt, @role, @text, @praise, @correction, @newWord, @audioBase64, @userId)
    ON CONFLICT(id) DO UPDATE SET
      session_id = excluded.session_id,
      created_at = excluded.created_at,
      role = excluded.role,
      text = excluded.text,
      praise = excluded.praise,
      correction = excluded.correction,
      new_word = excluded.new_word,
      audio_base64 = COALESCE(excluded.audio_base64, messages.audio_base64),
      user_id = COALESCE(excluded.user_id, messages.user_id)
  `);
  const run = getDb().transaction((msgs: StoredMessage[]) => {
    for (const message of msgs) stmt.run(toBind(message, userId));
  });
  run(messages);
  return messages.length;
}

export function deleteMessagesBySession(
  userId: string,
  sessionId: string
): number {
  const info = getDb()
    .prepare("DELETE FROM messages WHERE user_id = ? AND session_id = ?")
    .run(userId, sessionId);
  return info.changes;
}

export function deleteAllMessages(userId: string): number {
  const info = getDb()
    .prepare("DELETE FROM messages WHERE user_id = ?")
    .run(userId);
  return info.changes;
}

export function updateMessageAudio(
  userId: string,
  id: string,
  audioBase64: string
): boolean {
  const info = getDb()
    .prepare(
      "UPDATE messages SET audio_base64 = ? WHERE user_id = ? AND id = ?"
    )
    .run(audioBase64, userId, id);
  return info.changes > 0;
}

// ---------------------------------------------------------------------------
// Orphan adoption — pre-auth messages (user_id NULL) belong to the FIRST
// registered user. Later registrations never adopt; stray rows only warn.
// ---------------------------------------------------------------------------

export function countOrphanMessages(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id IS NULL")
    .get() as { n: number };
  return row.n;
}

export function adoptOrphanMessages(userId: string): number {
  const info = getDb()
    .prepare("UPDATE messages SET user_id = ? WHERE user_id IS NULL")
    .run(userId);
  return info.changes;
}

// ---------------------------------------------------------------------------
// Session metadata (chat vs lesson, lesson results)
// ---------------------------------------------------------------------------

function rowToSessionMeta(row: SessionMetaRow): StoredSessionMeta {
  return {
    id: row.id,
    type: row.type === "lesson" ? "lesson" : "chat",
    ...(row.lesson_id !== null ? { lessonId: row.lesson_id } : {}),
    ...(row.lesson_title !== null ? { lessonTitle: row.lesson_title } : {}),
    ...(row.duration_minutes !== null
      ? { durationMinutes: row.duration_minutes }
      : {}),
    ...(row.completed_steps !== null
      ? { completedSteps: row.completed_steps }
      : {}),
    ...(row.total_steps !== null ? { totalSteps: row.total_steps } : {}),
    ...(row.stars_earned !== null ? { starsEarned: row.stars_earned } : {}),
    ...(row.corrections_count !== null
      ? { correctionsCount: row.corrections_count }
      : {}),
    ...(row.timed_out === 1 ? { timedOut: true } : {}),
    ...(row.accent !== null ? { accent: row.accent } : {}),
    updatedAt: row.updated_at,
  };
}

/** All session metadata rows for a user, oldest first. */
export function listSessionMeta(userId: string): StoredSessionMeta[] {
  const rows = getDb()
    .prepare(
      `SELECT id, user_id, type, lesson_id, lesson_title, duration_minutes,
              completed_steps, total_steps, stars_earned, corrections_count,
              timed_out, accent, updated_at
       FROM session_meta WHERE user_id = ? ORDER BY updated_at ASC`
    )
    .all(userId) as SessionMetaRow[];
  return rows.map(rowToSessionMeta);
}

/** Upsert one session-metadata row. */
export function upsertSessionMeta(
  userId: string,
  meta: StoredSessionMeta
): void {
  getDb()
    .prepare(
      `INSERT INTO session_meta (
         id, user_id, type, lesson_id, lesson_title, duration_minutes,
         completed_steps, total_steps, stars_earned, corrections_count,
         timed_out, accent, updated_at
       ) VALUES (
         @id, @userId, @type, @lessonId, @lessonTitle, @durationMinutes,
         @completedSteps, @totalSteps, @starsEarned, @correctionsCount,
         @timedOut, @accent, @updatedAt
       )
       ON CONFLICT(id) DO UPDATE SET
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
         updated_at = excluded.updated_at`
    )
    .run({
      id: meta.id,
      userId,
      type: meta.type === "lesson" ? "lesson" : "chat",
      lessonId: meta.lessonId ?? null,
      lessonTitle: meta.lessonTitle ?? null,
      durationMinutes: meta.durationMinutes ?? null,
      completedSteps: meta.completedSteps ?? null,
      totalSteps: meta.totalSteps ?? null,
      starsEarned: meta.starsEarned ?? null,
      correctionsCount: meta.correctionsCount ?? null,
      timedOut: meta.timedOut ? 1 : 0,
      accent: meta.accent ?? null,
      updatedAt: meta.updatedAt,
    });
}

export function deleteSessionMeta(userId: string, id: string): number {
  return getDb()
    .prepare("DELETE FROM session_meta WHERE user_id = ? AND id = ?")
    .run(userId, id).changes;
}

export function deleteAllSessionMeta(userId: string): number {
  return getDb()
    .prepare("DELETE FROM session_meta WHERE user_id = ?")
    .run(userId).changes;
}
