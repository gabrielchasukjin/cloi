/**
 * Session persistence.
 *
 * SQLite is the source of truth for conversation state, not a write-behind
 * cache. The agent loop rebuilds its model messages from this store on every
 * iteration, so an interrupted turn leaves behind a coherent, resumable
 * session rather than a half-written in-memory array.
 *
 * Uses node:sqlite (built in since Node 22.5), which keeps the install free of
 * native compilation.
 */

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { DB_PATH, ensureDataDir } from '../util/paths.js';

let db = null;

export function getDb() {
  if (db) return db;
  ensureDataDir();
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      title       TEXT,
      cwd         TEXT NOT NULL,
      model       TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      seq          INTEGER NOT NULL,
      role         TEXT NOT NULL,
      content      TEXT,
      tool_calls   TEXT,
      tool_call_id TEXT,
      tool_name    TEXT,
      is_error     INTEGER DEFAULT 0,
      created_at   INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS messages_session_seq
      ON messages(session_id, seq);

    CREATE TABLE IF NOT EXISTS session_state (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      todos      TEXT
    );
  `);
  return db;
}

export class Session {
  constructor(row) {
    this.id = row.id;
    this.cwd = row.cwd;
    this.model = row.model;
    this.title = row.title;
  }

  static create({ cwd, model, title = null }) {
    const database = getDb();
    const id = randomUUID();
    const now = Date.now();
    database
      .prepare('INSERT INTO sessions (id, title, cwd, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, title, cwd, model, now, now);
    return new Session({ id, title, cwd, model });
  }

  static load(id) {
    const row = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    return row ? new Session(row) : null;
  }

  /** Most recent session, used by `--continue`. */
  static latest(cwd = null) {
    const database = getDb();
    const row = cwd
      ? database.prepare('SELECT * FROM sessions WHERE cwd = ? ORDER BY updated_at DESC LIMIT 1').get(cwd)
      : database.prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 1').get();
    return row ? new Session(row) : null;
  }

  static list(limit = 20) {
    return getDb()
      .prepare(`
        SELECT s.*, COUNT(m.id) AS message_count
        FROM sessions s LEFT JOIN messages m ON m.session_id = s.id
        GROUP BY s.id ORDER BY s.updated_at DESC LIMIT ?
      `)
      .all(limit);
  }

  _nextSeq() {
    const row = getDb()
      .prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM messages WHERE session_id = ?')
      .get(this.id);
    return (row?.max_seq ?? 0) + 1;
  }

  _touch() {
    getDb().prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), this.id);
  }

  /**
   * Append a message.
   *
   * @param {object} msg
   * @param {'user'|'assistant'|'tool'|'system'} msg.role
   * @param {string} [msg.content]
   * @param {Array} [msg.toolCalls] Assistant tool calls.
   * @param {string} [msg.toolCallId] For tool results.
   * @param {string} [msg.toolName] For tool results.
   * @param {boolean} [msg.isError]
   */
  addMessage(msg) {
    const seq = this._nextSeq();
    getDb()
      .prepare(`
        INSERT INTO messages (session_id, seq, role, content, tool_calls, tool_call_id, tool_name, is_error, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        this.id,
        seq,
        msg.role,
        msg.content ?? '',
        msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
        msg.toolCallId ?? null,
        msg.toolName ?? null,
        msg.isError ? 1 : 0,
        Date.now(),
      );
    this._touch();

    // First user message doubles as the session title, for `cloi sessions`.
    if (msg.role === 'user' && !this.title) {
      const title = String(msg.content || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (title) {
        this.title = title;
        getDb().prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, this.id);
      }
    }
    return seq;
  }

  rows() {
    return getDb()
      .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC')
      .all(this.id);
  }

  messageCount() {
    const row = getDb()
      .prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?')
      .get(this.id);
    return row?.n ?? 0;
  }

  /**
   * Rebuild the wire-format message array from storage.
   *
   * Called fresh on every loop iteration, which is what makes the store
   * authoritative. `systemPrompt` is prepended here rather than persisted, so
   * prompt changes take effect on resumed sessions too.
   */
  buildModelMessages(systemPrompt) {
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });

    for (const row of this.rows()) {
      if (row.role === 'tool') {
        messages.push({
          role: 'tool',
          content: row.content ?? '',
          tool_name: row.tool_name ?? undefined,
        });
        continue;
      }

      const msg = { role: row.role, content: row.content ?? '' };
      if (row.tool_calls) {
        try {
          const calls = JSON.parse(row.tool_calls);
          if (Array.isArray(calls) && calls.length) {
            msg.tool_calls = calls.map((c) => ({
              function: { name: c.name, arguments: c.arguments },
            }));
          }
        } catch {}
      }
      messages.push(msg);
    }
    return messages;
  }

  getTodos() {
    const row = getDb().prepare('SELECT todos FROM session_state WHERE session_id = ?').get(this.id);
    if (!row?.todos) return [];
    try {
      return JSON.parse(row.todos);
    } catch {
      return [];
    }
  }

  setTodos(todos) {
    getDb()
      .prepare(`
        INSERT INTO session_state (session_id, todos) VALUES (?, ?)
        ON CONFLICT(session_id) DO UPDATE SET todos = excluded.todos
      `)
      .run(this.id, JSON.stringify(todos ?? []));
  }

  delete() {
    getDb().prepare('DELETE FROM sessions WHERE id = ?').run(this.id);
  }
}
