/**
 * One-time migration: data/english-buddy.db (SQLite) → Postgres.
 *
 * Run once, while both drivers are installed:
 *   DATABASE_URL=postgresql://… node scripts/migrate-sqlite-to-pg.mjs
 *
 * Idempotent: truncates the four app tables (CASCADE) and re-copies every
 * row, so re-running after a partial run is safe. The SQLite file is never
 * modified.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { Pool } from "pg";

const ROOT = process.cwd();
const SQLITE_PATH = path.join(ROOT, "data", "english-buddy.db");
const CONNECTION =
  process.env.DATABASE_URL ??
  "postgresql://127.0.0.1:5432/english_buddy";

if (!fs.existsSync(SQLITE_PATH)) {
  console.error(`✗ SQLite file not found: ${SQLITE_PATH}`);
  process.exit(1);
}

const sqlite = new Database(SQLITE_PATH, { readonly: true, fileMustExist: true });
const pool = new Pool({ connectionString: CONNECTION });

const users = sqlite.prepare("SELECT * FROM users").all();
const sessions = sqlite.prepare("SELECT * FROM auth_sessions").all();
const messages = sqlite.prepare("SELECT * FROM messages").all();
const meta = sqlite.prepare("SELECT * FROM session_meta").all();

console.log(
  `Source: ${users.length} users, ${sessions.length} auth sessions, ` +
    `${messages.length} messages, ${meta.length} session_meta rows`
);

const client = await pool.connect();
try {
  await client.query("BEGIN");
  // Reset target tables; FK order is handled by CASCADE / explicit TRUNCATE.
  await client.query(
    "TRUNCATE auth_sessions, session_meta, messages, users RESTART IDENTITY"
  );

  for (const u of users) {
    await client.query(
      `INSERT INTO users (id, username, display_name, password_hash, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [u.id, u.username, u.display_name, u.password_hash, Number(u.created_at)]
    );
  }

  for (const s of sessions) {
    await client.query(
      `INSERT INTO auth_sessions (token, user_id, expires_at)
       VALUES ($1, $2, $3)`,
      [s.token, s.user_id, Number(s.expires_at)]
    );
  }

  let orphanCount = 0;
  for (const m of messages) {
    if (m.user_id === null) orphanCount++;
    await client.query(
      `INSERT INTO messages (
         id, session_id, created_at, role, text, praise, correction,
         new_word, audio_base64, user_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        m.id,
        m.session_id,
        Number(m.created_at),
        m.role,
        m.text,
        m.praise,
        m.correction,
        m.new_word,
        m.audio_base64,
        m.user_id,
      ]
    );
  }

  for (const r of meta) {
    await client.query(
      `INSERT INTO session_meta (
         id, user_id, type, lesson_id, lesson_title, duration_minutes,
         completed_steps, total_steps, stars_earned, corrections_count,
         timed_out, accent, title, started_at, ended_at, duration_ms, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17
       )`,
      [
        r.id,
        r.user_id,
        r.type,
        r.lesson_id,
        r.lesson_title,
        r.duration_minutes === null ? null : Number(r.duration_minutes),
        r.completed_steps === null ? null : Number(r.completed_steps),
        r.total_steps === null ? null : Number(r.total_steps),
        r.stars_earned === null ? null : Number(r.stars_earned),
        r.corrections_count === null ? null : Number(r.corrections_count),
        // SQLite boolean-integer → Postgres boolean.
        r.timed_out === 1,
        r.accent,
        r.title,
        r.started_at === null ? null : Number(r.started_at),
        r.ended_at === null ? null : Number(r.ended_at),
        r.duration_ms === null ? null : Number(r.duration_ms),
        Number(r.updated_at),
      ]
    );
  }

  await client.query("COMMIT");
  console.log(
    `✓ Migrated. Orphan (user_id NULL) messages: ${orphanCount}`
  );
} catch (err) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("✗ Migration failed (rolled back):", err);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
  sqlite.close();
}
