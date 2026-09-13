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

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;

  const dataDir = path.join(process.cwd(), "data");
  fs.mkdirSync(dataDir, { recursive: true });
  db = new Database(path.join(dataDir, "english-buddy.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 3000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'ai')),
      text TEXT NOT NULL,
      praise TEXT,
      correction TEXT,
      new_word TEXT,
      audio_base64 TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages (created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages (session_id);
  `);
  return db;
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
}

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

/** All messages, oldest first. Audio excluded to keep payloads light. */
export function listMessages(): StoredMessage[] {
  const rows = getDb()
    .prepare(
      `SELECT id, session_id, created_at, role, text, praise, correction, new_word, audio_base64
       FROM messages ORDER BY created_at ASC`
    )
    .all() as MessageRow[];
  return rows.map((row) => rowToMessage(row, false));
}

function toBind(message: StoredMessage) {
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
  };
}

/** Upsert messages. Existing audio is kept when the incoming copy has none. */
export function upsertMessages(messages: StoredMessage[]): number {
  const stmt = getDb().prepare(`
    INSERT INTO messages (id, session_id, created_at, role, text, praise, correction, new_word, audio_base64)
    VALUES (@id, @sessionId, @createdAt, @role, @text, @praise, @correction, @newWord, @audioBase64)
    ON CONFLICT(id) DO UPDATE SET
      session_id = excluded.session_id,
      created_at = excluded.created_at,
      role = excluded.role,
      text = excluded.text,
      praise = excluded.praise,
      correction = excluded.correction,
      new_word = excluded.new_word,
      audio_base64 = COALESCE(excluded.audio_base64, messages.audio_base64)
  `);
  const run = getDb().transaction((msgs: StoredMessage[]) => {
    for (const message of msgs) stmt.run(toBind(message));
  });
  run(messages);
  return messages.length;
}

export function deleteMessagesBySession(sessionId: string): number {
  const info = getDb()
    .prepare("DELETE FROM messages WHERE session_id = ?")
    .run(sessionId);
  return info.changes;
}

export function deleteAllMessages(): number {
  const info = getDb().prepare("DELETE FROM messages").run();
  return info.changes;
}

export function updateMessageAudio(
  id: string,
  audioBase64: string
): boolean {
  const info = getDb()
    .prepare("UPDATE messages SET audio_base64 = ? WHERE id = ?")
    .run(audioBase64, id);
  return info.changes > 0;
}
