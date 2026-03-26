import { Database } from "bun:sqlite";

export type MessageRole = "user" | "assistant" | "system";

export type MemoryMessage = {
  role: MessageRole;
  content: string;
};

const db = new Database("agent_memory.sqlite");

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

const insertStmt = db.prepare(
  "INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)",
);

const historyStmt = db.prepare(`
  SELECT role, content
  FROM (
    SELECT id, role, content
    FROM messages
    WHERE session_id = ?
    ORDER BY id DESC
    LIMIT ?
  )
  ORDER BY id ASC
`);

const clearStmt = db.prepare("DELETE FROM messages WHERE session_id = ?");

export const memory = {
  addMessage(sessionId: string, role: MessageRole, content: string): void {
    insertStmt.run(sessionId, role, content);
  },

  getHistory(sessionId: string, limit = 10): MemoryMessage[] {
    return historyStmt.all(sessionId, limit) as MemoryMessage[];
  },

  clearSession(sessionId: string): void {
    clearStmt.run(sessionId);
  },
};
