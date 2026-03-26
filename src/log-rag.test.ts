import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ingestLogEvidenceNdjson,
  resetLogEvidenceStoreForTests,
  searchLogEvidence,
} from "./log-rag";

describe("log rag", () => {
  beforeEach(() => {
    process.env.LOG_RAG_DB_FILE = `/tmp/gleipnir-log-rag-${crypto.randomUUID()}.sqlite`;
    resetLogEvidenceStoreForTests();
  });

  afterEach(() => {
    resetLogEvidenceStoreForTests();
    delete process.env.LOG_RAG_DB_FILE;
  });

  test("ingests AI-related NDJSON and retrieves ranked evidence", async () => {
    const ndjson = [
      JSON.stringify({
        timestamp: 1,
        source: "http_parser",
        comm: "proxy",
        data: {
          message_type: "request",
          method: "POST",
          path: "/v1/chat/completions",
          headers: { host: "api.openai.com" },
          first_line: "POST /v1/chat/completions HTTP/1.1",
        },
      }),
      JSON.stringify({
        timestamp: 2,
        source: "http_parser",
        comm: "proxy",
        data: {
          message_type: "response",
          status_code: 200,
          path: "/v1/chat/completions",
          headers: { host: "api.openai.com" },
          first_line: "HTTP/1.1 200 OK",
        },
      }),
      JSON.stringify({
        timestamp: 3,
        source: "http_parser",
        comm: "proxy",
        data: {
          message_type: "request",
          method: "GET",
          path: "/api/health",
          first_line: "GET /api/health HTTP/1.1",
        },
      }),
      JSON.stringify({
        timestamp: 4,
        source: "sse_processor",
        comm: "claude-client",
        data: {
          type: "response",
          text_content: "assistant response mentions a secret leak incident",
          event_count: 12,
        },
      }),
    ].join("\n");

    const ingestResult = await ingestLogEvidenceNdjson(ndjson, {
      sourceFile: "logs/sample.ndjson",
    });

    expect(ingestResult.ok).toBe(true);
    expect(ingestResult.indexedDocs).toBe(3);
    expect(ingestResult.skippedNonAi).toBe(1);

    const requestSearch = searchLogEvidence({
      query: "chat completions",
      requestResponseType: "request",
      limit: 5,
    });

    expect(requestSearch.ok).toBe(true);
    expect(requestSearch.total).toBe(1);
    expect(requestSearch.items[0]?.requestResponseType).toBe("request");
    expect(requestSearch.items[0]?.path).toBe("/v1/chat/completions");

    const evidenceSearch = searchLogEvidence({
      query: "secret leak",
      source: "sse_processor",
      includeRaw: true,
    });

    expect(evidenceSearch.total).toBe(1);
    expect(evidenceSearch.items[0]?.summary).toContain("secret leak");
    expect(evidenceSearch.items[0]?.raw).toBeDefined();
  });

  test("supports decoded NDJSON shape and path filters", async () => {
    const ndjson = [
      JSON.stringify({
        timestamp: "2026-03-26T12:00:00Z",
        source: "http_parser",
        comm: "openclaw",
        http: {
          type: "request",
          first_line: "POST /v1/messages HTTP/1.1",
          path: "/v1/messages",
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-26T12:00:01Z",
        source: "ssl",
        comm: "openclaw",
        function: "READ/RECV",
        decoded: {
          preview: "{\"type\":\"message_stop\",\"model\":\"claude\"}",
        },
      }),
    ].join("\n");

    await ingestLogEvidenceNdjson(ndjson, {
      sourceFile: "logs/decoded.ndjson",
    });

    const result = searchLogEvidence({
      query: "message_stop claude",
      source: "ssl",
      limit: 5,
    });

    expect(result.total).toBe(1);
    expect(result.items[0]?.sourceFile).toBe("logs/decoded.ndjson");

    const requestResult = searchLogEvidence({
      query: "v1 messages",
      pathKeyword: "/v1/messages",
      requestResponseType: "request",
    });

    expect(requestResult.total).toBe(1);
    expect(requestResult.items[0]?.requestResponseType).toBe("request");
  });
});
