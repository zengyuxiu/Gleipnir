import { Database } from "bun:sqlite";

export type RequestResponseType = "request" | "response" | "unknown";

export type LogEvidenceDoc = {
  docKey: string;
  sourceFile: string;
  sourceLine: number;
  timestamp: string | null;
  source: string;
  comm: string | null;
  requestResponseType: RequestResponseType;
  host: string | null;
  method: string | null;
  path: string | null;
  statusCode: number | null;
  messageId: string | null;
  connectionId: string | null;
  summary: string;
  content: string;
  tags: string[];
  rawJson: string;
};

export type IngestLogEvidenceOptions = {
  sourceFile?: string;
  aiOnly?: boolean;
};

export type IngestLogEvidenceResult = {
  ok: true;
  dbPath: string;
  sourceFile: string;
  totalLines: number;
  parsedEvents: number;
  indexedDocs: number;
  invalidJsonLines: number;
  skippedNonAi: number;
  skippedEmpty: number;
  ftsEnabled: boolean;
};

export type SearchLogEvidenceParams = {
  query: string;
  limit?: number;
  requestResponseType?: RequestResponseType | "both";
  source?: string;
  host?: string;
  pathKeyword?: string;
  includeRaw?: boolean;
};

export type SearchLogEvidenceItem = {
  docKey: string;
  sourceFile: string;
  sourceLine: number;
  timestamp: string | null;
  source: string;
  comm: string | null;
  requestResponseType: RequestResponseType;
  host: string | null;
  method: string | null;
  path: string | null;
  statusCode: number | null;
  messageId: string | null;
  connectionId: string | null;
  summary: string;
  snippet: string;
  tags: string[];
  score: number | null;
  raw?: unknown;
};

export type SearchLogEvidenceResult = {
  ok: true;
  dbPath: string;
  query: string;
  limit: number;
  total: number;
  ftsEnabled: boolean;
  items: SearchLogEvidenceItem[];
};

type LogRagDbState = {
  path: string;
  db: Database;
  ftsEnabled: boolean;
  schemaReady: boolean;
};

type SqlBinding = string | number | bigint | boolean | Uint8Array | null;

type ExtractedEventFields = {
  timestamp: string | null;
  source: string;
  comm: string | null;
  requestResponseType: RequestResponseType;
  host: string | null;
  method: string | null;
  path: string | null;
  statusCode: number | null;
  summary: string;
  content: string;
  tags: string[];
  messageId: string | null;
  connectionId: string | null;
};

type SearchRow = {
  doc_key: string;
  source_file: string;
  source_line: number;
  timestamp: string | null;
  source: string;
  comm: string | null;
  request_response_type: string;
  host: string | null;
  method: string | null;
  path: string | null;
  status_code: number | null;
  message_id: string | null;
  connection_id: string | null;
  summary: string;
  tags: string;
  raw_json: string;
  snippet?: string | null;
  score?: number | null;
};

let dbState: LogRagDbState | null = null;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asJsonText(value: unknown, maxLength = 1200): string | null {
  if (value == null) {
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed.slice(0, maxLength) : null;
  }
  try {
    return JSON.stringify(value).slice(0, maxLength);
  } catch {
    return null;
  }
}

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const value of values) {
    if (!value) {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }

  return out;
}

function getDbPath(): string {
  return process.env.LOG_RAG_DB_FILE ?? "log_rag.sqlite";
}

function getDbState(): LogRagDbState {
  const path = getDbPath();
  if (dbState && dbState.path === path) {
    ensureSchema(dbState);
    return dbState;
  }

  if (dbState) {
    try {
      dbState.db.close();
    } catch {
      // Best-effort cleanup for tests and env switches.
    }
  }

  dbState = {
    path,
    db: new Database(path),
    ftsEnabled: true,
    schemaReady: false,
  };
  ensureSchema(dbState);
  return dbState;
}

function ensureSchema(state: LogRagDbState): void {
  if (state.schemaReady) {
    return;
  }

  state.db.run(`
    CREATE TABLE IF NOT EXISTS log_evidence_docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_key TEXT NOT NULL UNIQUE,
      source_file TEXT NOT NULL,
      source_line INTEGER NOT NULL,
      timestamp TEXT,
      source TEXT NOT NULL,
      comm TEXT,
      request_response_type TEXT NOT NULL,
      host TEXT,
      method TEXT,
      path TEXT,
      status_code INTEGER,
      message_id TEXT,
      connection_id TEXT,
      summary TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  try {
    state.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS log_evidence_fts
      USING fts5(summary, content, tags, path, host, source, comm)
    `);
    state.ftsEnabled = true;
  } catch {
    state.ftsEnabled = false;
  }

  state.schemaReady = true;
}

function parseRequestLine(firstLine: string | null): {
  method: string | null;
  path: string | null;
} {
  if (!firstLine) {
    return { method: null, path: null };
  }

  const match = /^([A-Z]+)\s+(\S+)/.exec(firstLine);
  if (!match) {
    return { method: null, path: null };
  }

  return {
    method: match[1] ?? null,
    path: match[2] ?? null,
  };
}

function classifyRequestResponse(event: unknown): RequestResponseType {
  const e = asRecord(event);
  const d = asRecord(e.data);
  const http = asRecord(e.http);
  const source = String(e.source ?? "").toLowerCase();

  if (source === "sse_processor") {
    return "response";
  }

  const messageType = String(d.message_type ?? d.type ?? http.type ?? "").toLowerCase();
  if (messageType === "request" || messageType === "req") {
    return "request";
  }
  if (messageType === "response" || messageType === "res" || messageType === "respond") {
    return "response";
  }

  const method = asString(d.method) ?? parseRequestLine(asString(http.first_line)).method;
  if (method && asNumber(d.status_code ?? http.status_code) == null) {
    return "request";
  }

  if (asNumber(d.status_code ?? http.status_code) != null) {
    return "response";
  }

  const fn = String(d.function ?? e.function ?? "").toUpperCase();
  if (fn === "WRITE/SEND") {
    return "request";
  }
  if (fn === "READ/RECV") {
    return "response";
  }

  return "unknown";
}

function looksLikeAiPath(path: string): boolean {
  const lowered = path.toLowerCase();
  return (
    lowered.includes("/v1/messages") ||
    lowered.includes("/v1/chat/completions") ||
    lowered.includes("/v1/responses") ||
    lowered.includes("/chat/completions")
  );
}

function looksLikeAiHost(host: string): boolean {
  const lowered = host.toLowerCase();
  return (
    lowered.includes("openai.com") ||
    lowered.includes("anthropic.com") ||
    lowered.includes("claude.ai") ||
    lowered.includes("deepseek.com") ||
    lowered.includes("aliyuncs.com") ||
    lowered.includes("modelscope")
  );
}

function compactSummary(summary: string | null, fallbackParts: string[]): string {
  const candidate = summary?.trim();
  if (candidate && candidate.length > 0 && candidate !== "n/a") {
    return candidate.slice(0, 220);
  }
  const fallback = fallbackParts.find((part) => part.trim().length > 0);
  return fallback ? fallback.slice(0, 220) : "n/a";
}

function extractEventFields(event: unknown): ExtractedEventFields {
  const e = asRecord(event);
  const d = asRecord(e.data);
  const http = asRecord(e.http);
  const decoded = asRecord(e.decoded);
  const headers = asRecord(d.headers);
  const frame = asRecord(decoded.frame);

  const timestampValue = e.timestamp;
  const timestamp =
    typeof timestampValue === "string" || typeof timestampValue === "number"
      ? String(timestampValue)
      : null;
  const source = asString(e.source) ?? "unknown";
  const comm = asString(e.comm);
  const requestResponseType = classifyRequestResponse(event);

  const httpFirstLine = asString(http.first_line);
  const requestLine = parseRequestLine(httpFirstLine);
  const method = asString(d.method) ?? requestLine.method;
  const path = asString(d.path) ?? asString(http.path) ?? requestLine.path;
  const host =
    asString(headers.host) ??
    asString(d.host) ??
    asString(http.host);
  const statusCode = asNumber(d.status_code ?? http.status_code);
  const eventName = asString(d.event);
  const textContent = asString(d.text_content);
  const preview =
    asString(decoded.preview) ??
    asString(decoded.gzip_text_preview) ??
    asString(frame.text) ??
    asJsonText(frame.json);
  const firstLine = asString(d.first_line) ?? httpFirstLine;
  const summary = compactSummary(
    firstLine ?? textContent ?? preview ?? eventName,
    uniqueNonEmpty([
      [method, path].filter(Boolean).join(" ").trim(),
      [statusCode != null ? String(statusCode) : null, path].filter(Boolean).join(" ").trim(),
      source,
    ]),
  );

  const messageId =
    asString(d.message_id) ??
    asString(asRecord(d.message).id) ??
    asString(e.message_id);
  const connectionId =
    asString(d.connection_id) ??
    asString(asRecord(d.meta).connection_id) ??
    asString(e.connection_id);

  const tags = uniqueNonEmpty([
    source,
    comm,
    requestResponseType,
    host,
    method,
    path,
    eventName,
    statusCode != null ? `status:${statusCode}` : null,
  ]);

  const content = uniqueNonEmpty([
    `source:${source}`,
    comm ? `comm:${comm}` : null,
    `direction:${requestResponseType}`,
    host ? `host:${host}` : null,
    method ? `method:${method}` : null,
    path ? `path:${path}` : null,
    statusCode != null ? `status:${statusCode}` : null,
    firstLine,
    textContent,
    preview,
    eventName ? `event:${eventName}` : null,
    asJsonText(d.partial_json),
    asJsonText(d.json_content),
  ]).join("\n").slice(0, 4000);

  return {
    timestamp,
    source,
    comm,
    requestResponseType,
    host,
    method,
    path,
    statusCode,
    summary,
    content,
    tags,
    messageId,
    connectionId,
  };
}

function isAiRelatedEvent(event: unknown, fields: ExtractedEventFields): boolean {
  if (fields.source === "sse_processor") {
    return true;
  }
  if (fields.path && looksLikeAiPath(fields.path)) {
    return true;
  }
  if (fields.host && looksLikeAiHost(fields.host)) {
    return true;
  }

  const blob = uniqueNonEmpty([
    fields.summary,
    fields.content,
    asJsonText(event, 4000),
  ])
    .join("\n")
    .toLowerCase();

  const aiKeywords = [
    "openai",
    "anthropic",
    "claude",
    "gpt",
    "llm",
    "assistant",
    "/v1/messages",
    "/v1/chat/completions",
    "/v1/responses",
    "message_start",
    "content_block_delta",
    "text/event-stream",
  ];

  return aiKeywords.some((keyword) => blob.includes(keyword));
}

function normalizeEventToDoc(
  event: unknown,
  sourceFile: string,
  sourceLine: number,
  aiOnly: boolean,
): LogEvidenceDoc | null {
  const rawJson = asJsonText(event, 20000);
  if (!rawJson) {
    return null;
  }

  const fields = extractEventFields(event);
  if (fields.content.length === 0) {
    return null;
  }

  if (aiOnly && !isAiRelatedEvent(event, fields)) {
    return null;
  }

  return {
    docKey: `${sourceFile}:${sourceLine}`,
    sourceFile,
    sourceLine,
    timestamp: fields.timestamp,
    source: fields.source,
    comm: fields.comm,
    requestResponseType: fields.requestResponseType,
    host: fields.host,
    method: fields.method,
    path: fields.path,
    statusCode: fields.statusCode,
    messageId: fields.messageId,
    connectionId: fields.connectionId,
    summary: fields.summary,
    content: fields.content,
    tags: fields.tags,
    rawJson,
  };
}

function buildFtsQuery(query: string): string {
  const tokens = query
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map((token) => `"${token.replaceAll('"', '""')}"`);

  if (tokens.length === 0) {
    return "";
  }

  return tokens.join(" AND ");
}

function parseNdjson(text: string): Array<{ lineNumber: number; value: unknown }> {
  const rows: Array<{ lineNumber: number; value: unknown }> = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    rows.push({
      lineNumber: index + 1,
      value: JSON.parse(trimmed) as unknown,
    });
  }
  return rows;
}

function deleteExistingDoc(state: LogRagDbState, docKey: string): void {
  const db = state.db;
  const row = db
    .query("SELECT id FROM log_evidence_docs WHERE doc_key = ?")
    .get(docKey) as { id: number } | null;
  if (!row) {
    return;
  }
  if (state.ftsEnabled) {
    db.query("DELETE FROM log_evidence_fts WHERE rowid = ?").run(row.id);
  }
  db.query("DELETE FROM log_evidence_docs WHERE id = ?").run(row.id);
}

function insertDoc(state: LogRagDbState, doc: LogEvidenceDoc): void {
  deleteExistingDoc(state, doc.docKey);

  state.db
    .query(`
      INSERT INTO log_evidence_docs (
        doc_key,
        source_file,
        source_line,
        timestamp,
        source,
        comm,
        request_response_type,
        host,
        method,
        path,
        status_code,
        message_id,
        connection_id,
        summary,
        content,
        tags,
        raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      doc.docKey,
      doc.sourceFile,
      doc.sourceLine,
      doc.timestamp,
      doc.source,
      doc.comm,
      doc.requestResponseType,
      doc.host,
      doc.method,
      doc.path,
      doc.statusCode,
      doc.messageId,
      doc.connectionId,
      doc.summary,
      doc.content,
      doc.tags.join(" "),
      doc.rawJson,
    );

  if (!state.ftsEnabled) {
    return;
  }

  const inserted = state.db
    .query("SELECT id FROM log_evidence_docs WHERE doc_key = ?")
    .get(doc.docKey) as { id: number } | null;
  if (!inserted) {
    return;
  }

  state.db
    .query(`
      INSERT INTO log_evidence_fts (
        rowid,
        summary,
        content,
        tags,
        path,
        host,
        source,
        comm
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      inserted.id,
      doc.summary,
      doc.content,
      doc.tags.join(" "),
      doc.path ?? "",
      doc.host ?? "",
      doc.source,
      doc.comm ?? "",
    );
}

export async function ingestLogEvidenceNdjson(
  text: string,
  options: IngestLogEvidenceOptions = {},
): Promise<IngestLogEvidenceResult> {
  const state = getDbState();
  const sourceFile = options.sourceFile ?? "inline.ndjson";
  const aiOnly = options.aiOnly ?? true;

  let totalLines = 0;
  let parsedEvents = 0;
  let indexedDocs = 0;
  let invalidJsonLines = 0;
  let skippedNonAi = 0;
  let skippedEmpty = 0;

  state.db.run("BEGIN");
  try {
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      totalLines += 1;
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      let value: unknown;
      try {
        value = JSON.parse(trimmed) as unknown;
        parsedEvents += 1;
      } catch {
        invalidJsonLines += 1;
        continue;
      }

      const doc = normalizeEventToDoc(value, sourceFile, index + 1, aiOnly);
      if (!doc) {
        const fields = extractEventFields(value);
        if (fields.content.length === 0) {
          skippedEmpty += 1;
        } else {
          skippedNonAi += 1;
        }
        continue;
      }

      insertDoc(state, doc);
      indexedDocs += 1;
    }

    state.db.run("COMMIT");
  } catch (error) {
    state.db.run("ROLLBACK");
    throw error;
  }

  return {
    ok: true,
    dbPath: state.path,
    sourceFile,
    totalLines,
    parsedEvents,
    indexedDocs,
    invalidJsonLines,
    skippedNonAi,
    skippedEmpty,
    ftsEnabled: state.ftsEnabled,
  };
}

export async function ingestLogEvidenceFromFile(
  inputPath: string,
  options: IngestLogEvidenceOptions = {},
): Promise<IngestLogEvidenceResult> {
  const file = Bun.file(inputPath);
  if (!(await file.exists())) {
    throw new Error(`input file not found: ${inputPath}`);
  }
  const text = await file.text();
  return ingestLogEvidenceNdjson(text, {
    ...options,
    sourceFile: options.sourceFile ?? inputPath,
  });
}

function buildSearchWhere(params: SearchLogEvidenceParams): {
  whereSql: string;
  bindings: SqlBinding[];
} {
  const clauses: string[] = [];
  const bindings: SqlBinding[] = [];

  if (params.requestResponseType && params.requestResponseType !== "both") {
    clauses.push("d.request_response_type = ?");
    bindings.push(params.requestResponseType);
  }

  if (params.source) {
    clauses.push("d.source = ?");
    bindings.push(params.source);
  }

  if (params.host) {
    clauses.push("d.host LIKE ?");
    bindings.push(`%${params.host}%`);
  }

  if (params.pathKeyword) {
    clauses.push("d.path LIKE ?");
    bindings.push(`%${params.pathKeyword}%`);
  }

  return {
    whereSql: clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "",
    bindings,
  };
}

function toSearchItem(row: SearchRow, includeRaw: boolean): SearchLogEvidenceItem {
  const tags = row.tags
    .split(/\s+/)
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);

  const item: SearchLogEvidenceItem = {
    docKey: row.doc_key,
    sourceFile: row.source_file,
    sourceLine: row.source_line,
    timestamp: row.timestamp,
    source: row.source,
    comm: row.comm,
    requestResponseType:
      row.request_response_type === "request" ||
      row.request_response_type === "response" ||
      row.request_response_type === "unknown"
        ? row.request_response_type
        : "unknown",
    host: row.host,
    method: row.method,
    path: row.path,
    statusCode: row.status_code,
    messageId: row.message_id,
    connectionId: row.connection_id,
    summary: row.summary,
    snippet: row.snippet?.trim() || row.summary,
    tags,
    score: row.score ?? null,
  };

  if (includeRaw) {
    try {
      item.raw = JSON.parse(row.raw_json) as unknown;
    } catch {
      item.raw = row.raw_json;
    }
  }

  return item;
}

export function searchLogEvidence(params: SearchLogEvidenceParams): SearchLogEvidenceResult {
  const state = getDbState();
  const query = params.query.trim();
  if (query.length === 0) {
    throw new Error("query cannot be empty");
  }

  const limit = Math.max(1, Math.min(20, Math.floor(params.limit ?? 5)));
  const includeRaw = params.includeRaw ?? false;
  const search = buildSearchWhere(params);

  let rows: SearchRow[] = [];

  if (state.ftsEnabled) {
    const ftsQuery = buildFtsQuery(query);
    if (ftsQuery.length > 0) {
      rows = state.db
        .query(`
          SELECT
            d.doc_key,
            d.source_file,
            d.source_line,
            d.timestamp,
            d.source,
            d.comm,
            d.request_response_type,
            d.host,
            d.method,
            d.path,
            d.status_code,
            d.message_id,
            d.connection_id,
            d.summary,
            d.tags,
            d.raw_json,
            snippet(log_evidence_fts, 1, '[', ']', ' ... ', 18) AS snippet,
            bm25(log_evidence_fts, 5.0, 1.0, 0.5, 0.5, 0.2, 0.2, 0.2) AS score
          FROM log_evidence_fts
          JOIN log_evidence_docs d ON d.id = log_evidence_fts.rowid
          WHERE log_evidence_fts MATCH ?${search.whereSql}
          ORDER BY score ASC, d.id DESC
          LIMIT ?
        `)
        .all(ftsQuery, ...search.bindings, limit) as SearchRow[];
    }
  }

  if (rows.length === 0) {
    rows = state.db
      .query(`
        SELECT
          d.doc_key,
          d.source_file,
          d.source_line,
          d.timestamp,
          d.source,
          d.comm,
          d.request_response_type,
          d.host,
          d.method,
          d.path,
          d.status_code,
          d.message_id,
          d.connection_id,
          d.summary,
          d.tags,
          d.raw_json,
          d.summary AS snippet,
          NULL AS score
        FROM log_evidence_docs d
        WHERE (d.summary LIKE ? OR d.content LIKE ?)${search.whereSql}
        ORDER BY d.id DESC
        LIMIT ?
      `)
      .all(`%${query}%`, `%${query}%`, ...search.bindings, limit) as SearchRow[];
  }

  return {
    ok: true,
    dbPath: state.path,
    query,
    limit,
    total: rows.length,
    ftsEnabled: state.ftsEnabled,
    items: rows.map((row) => toSearchItem(row, includeRaw)),
  };
}

export function resetLogEvidenceStoreForTests(): void {
  if (!dbState) {
    return;
  }
  try {
    dbState.db.close();
  } catch {
    // Ignore close errors during tests.
  }
  dbState = null;
}
