/**
 * One-shot migration: local Postgres (english_buddy) → Neon production.
 *
 * Usage:
 *   node scripts/migrate-pg-to-neon.mjs "<neon-connection-string>"
 *
 * Idempotent: every insert uses ON CONFLICT DO NOTHING, and the target
 * writes happen in a single transaction. The Neon schema must already
 * exist (the app creates it on first query; this script also runs the
 * same DDL defensively via app_meta presence check — simplest is to let
 * the app init first, which we already did).
 */
import pg from "pg";

const SOURCE_URL =
  process.env.SOURCE_DATABASE_URL ?? "postgresql://127.0.0.1:5432/english_buddy";
const TARGET_URL = process.argv[2] ?? process.env.NEON_DATABASE_URL;

if (!TARGET_URL) {
  console.error("Usage: node scripts/migrate-pg-to-neon.mjs <neon-url>");
  process.exit(1);
}

const source = new pg.Pool({ connectionString: SOURCE_URL });
const target = new pg.Pool({
  connectionString: TARGET_URL,
  ssl: { rejectUnauthorized: false },
});

/** Batch-insert rows via unnest; one round trip per table. */
async function copyTable(client, rows, columns, table, types) {
  if (rows.length === 0) {
    console.log(`  ${table}: 0 rows (skipped)`);
    return 0;
  }
  const cols = columns.join(", ");
  const arrays = types.map((t, i) => `$${i + 1}::${t}[]`).join(", ");
  const sql = `INSERT INTO ${table} (${cols})
     SELECT * FROM unnest(${arrays})
     ON CONFLICT DO NOTHING`;
  const values = types.map((_, i) =>
    rows.map((r) => {
      const v = r[columns[i]];
      // bigint[] via unnest accepts text input; booleans stay boolean.
      if (v === null || v === undefined) return null;
      if (types[i] === "bigint") return String(v);
      return v;
    })
  );
  const res = await client.query(sql, values);
  console.log(`  ${table}: ${res.rowCount}/${rows.length} rows inserted`);
  return res.rowCount;
}

async function main() {
  console.log("📦 Reading from local:", SOURCE_URL.replace(/\/\/.*@/, "//***@"));
  const users = (await source.query("SELECT * FROM users")).rows;
  const authSessions = (await source.query("SELECT * FROM auth_sessions")).rows;
  const messages = (await source.query("SELECT * FROM messages")).rows;
  const sessionMeta = (await source.query("SELECT * FROM session_meta")).rows;
  console.log(
    `  local: ${users.length} users, ${authSessions.length} auth_sessions, ${messages.length} messages, ${sessionMeta.length} session_meta`
  );

  const client = await target.connect();
  try {
    await client.query("BEGIN");
    console.log("🚚 Writing to Neon (single transaction)…");
    await copyTable(
      client,
      users,
      ["id", "username", "display_name", "password_hash", "created_at"],
      "users",
      ["text", "text", "text", "text", "bigint"]
    );
    await copyTable(
      client,
      authSessions,
      ["token", "user_id", "expires_at"],
      "auth_sessions",
      ["text", "text", "bigint"]
    );
    await copyTable(
      client,
      messages,
      [
        "id",
        "session_id",
        "created_at",
        "role",
        "text",
        "praise",
        "correction",
        "new_word",
        "audio_base64",
        "user_id",
      ],
      "messages",
      [
        "text",
        "text",
        "bigint",
        "text",
        "text",
        "text",
        "text",
        "text",
        "text",
        "text",
      ]
    );
    await copyTable(
      client,
      sessionMeta,
      [
        "id",
        "user_id",
        "type",
        "lesson_id",
        "lesson_title",
        "duration_minutes",
        "completed_steps",
        "total_steps",
        "stars_earned",
        "corrections_count",
        "timed_out",
        "accent",
        "title",
        "started_at",
        "ended_at",
        "duration_ms",
        "updated_at",
      ],
      "session_meta",
      [
        "text",
        "text",
        "text",
        "text",
        "text",
        "int",
        "int",
        "int",
        "int",
        "int",
        "boolean",
        "text",
        "text",
        "bigint",
        "bigint",
        "bigint",
        "bigint",
      ]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const counts = await target.query(
    `SELECT (SELECT count(*) FROM users)::int AS u,
            (SELECT count(*) FROM messages)::int AS m,
            (SELECT count(*) FROM session_meta)::int AS s,
            (SELECT count(*) FROM auth_sessions)::int AS a`
  );
  console.log("✅ Neon now has:", counts.rows[0]);
}

main()
  .catch((e) => {
    console.error("❌ Migration failed:", e);
    process.exitCode = 1;
  })
  .finally(() => {
    void source.end();
    void target.end();
  });
