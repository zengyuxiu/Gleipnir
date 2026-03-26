import { describe, expect, test } from "bun:test";
import {
  fetchAgentSightAiEvents,
  fetchAgentSightAiEventsStream,
  getAgentGuardianStatus,
  reloadAgentGuardianRules,
  validateAgentGuardianRules,
} from "./tools";

function createJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createSseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("fetchAgentSightAiEvents", () => {
  test("filters AI request/response events from JSON array", async () => {
    const events = [
      {
        timestamp: 1,
        source: "http_parser",
        comm: "proxy",
        data: {
          message_type: "request",
          method: "POST",
          path: "/v1/chat/completions",
          first_line: "POST /v1/chat/completions HTTP/1.1",
        },
      },
      {
        timestamp: 2,
        source: "http_parser",
        comm: "proxy",
        data: {
          message_type: "response",
          status_code: 200,
          path: "/v1/chat/completions",
          first_line: "HTTP/1.1 200 OK",
        },
      },
      {
        timestamp: 3,
        source: "http_parser",
        comm: "proxy",
        data: {
          message_type: "request",
          method: "GET",
          path: "/api/health",
          first_line: "GET /api/health HTTP/1.1",
        },
      },
    ];

    const fakeFetch = async () => createJsonResponse(events);
    const result = await fetchAgentSightAiEvents(
      { eventType: "both", limit: 50, includeRaw: false },
      fakeFetch,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Unexpected error result");
    }
    expect(result.matchedEvents).toBe(2);
    expect(result.returnedEvents).toBe(2);
    expect(result.items[0]?.requestResponseType).toBe("request");
    expect(result.items[1]?.requestResponseType).toBe("response");
  });

  test("supports eventType=request filter", async () => {
    const events = [
      {
        timestamp: 1,
        source: "http_parser",
        comm: "proxy",
        data: { message_type: "request", method: "POST", path: "/v1/messages" },
      },
      {
        timestamp: 2,
        source: "http_parser",
        comm: "proxy",
        data: { message_type: "response", status_code: 200, path: "/v1/messages" },
      },
    ];

    const fakeFetch = async () => createJsonResponse(events);
    const result = await fetchAgentSightAiEvents(
      { eventType: "request", limit: 50, includeRaw: false },
      fakeFetch,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Unexpected error result");
    }
    expect(result.returnedEvents).toBe(1);
    expect(result.items[0]?.requestResponseType).toBe("request");
  });

  test("parses JSONL and supports keyword filter + includeRaw", async () => {
    const jsonl = [
      JSON.stringify({
        timestamp: 1,
        source: "sse_processor",
        comm: "claude-client",
        data: { type: "response", text_content: "Claude model output hello" },
      }),
      JSON.stringify({
        timestamp: 2,
        source: "sse_processor",
        comm: "other-client",
        data: { type: "response", text_content: "non ai output" },
      }),
    ].join("\n");

    const fakeFetch = async () => new Response(jsonl, { status: 200 });
    const result = await fetchAgentSightAiEvents(
      {
        eventType: "both",
        limit: 50,
        keyword: "claude",
        includeRaw: true,
      },
      fakeFetch,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Unexpected error result");
    }
    expect(result.returnedEvents).toBe(1);
    expect(result.items[0]?.raw).toBeDefined();
  });

  test("returns error object when API responds with non-2xx", async () => {
    const fakeFetch = async () => createJsonResponse({ message: "nope" }, 500);
    const result = await fetchAgentSightAiEvents(
      { eventType: "both", limit: 50, includeRaw: false },
      fakeFetch,
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected error result");
    }
    expect(result.error).toContain("HTTP 500");
  });
});

describe("fetchAgentSightAiEventsStream", () => {
  test("parses SSE stream and filters AI request/response events", async () => {
    const chunks = [
      'event: agent\ndata: {"timestamp":1,"source":"http_parser","comm":"proxy","data":{"message_type":"request","method":"POST","path":"/v1/chat/completions","first_line":"POST /v1/chat/completions HTTP/1.1"}}\n\n',
      'event: agent\ndata: {"timestamp":2,"source":"http_parser","comm":"proxy","data":{"message_type":"response","status_code":200,"path":"/v1/chat/completions","first_line":"HTTP/1.1 200 OK"}}\n\n',
      'event: noise\ndata: {"timestamp":3,"source":"http_parser","comm":"proxy","data":{"message_type":"request","method":"GET","path":"/api/health"}}\n\n',
    ];

    const fakeFetch = async () => createSseResponse(chunks);
    const result = await fetchAgentSightAiEventsStream(
      { eventType: "both", limit: 50, includeRaw: false, timeoutMs: 3000 },
      fakeFetch,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Unexpected error result");
    }
    expect(result.matchedEvents).toBe(2);
    expect(result.returnedEvents).toBe(2);
    expect(result.items[0]?.requestResponseType).toBe("request");
    expect(result.items[1]?.requestResponseType).toBe("response");
  });

  test("returns error object when stream API responds with non-2xx", async () => {
    const fakeFetch = async () => createSseResponse(['data: {"message":"nope"}\n\n'], 500);
    const result = await fetchAgentSightAiEventsStream(
      { eventType: "both", limit: 50, includeRaw: false, timeoutMs: 3000 },
      fakeFetch,
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected error result");
    }
    expect(result.error).toContain("HTTP 500");
  });
});

describe("AgentGuardian tools", () => {
  test("getAgentGuardianStatus uses unix socket and returns status payload", async () => {
    const fakeFetch = async (input: string, init?: RequestInit & { unix?: string }) => {
      expect(input).toBe("http://unix/v1/status");
      expect(init?.method).toBe("GET");
      expect(init?.unix).toBe("/tmp/agentguardd.sock");
      return createJsonResponse({
        config_dir: "/etc/agentguardian",
        socket: "/tmp/agentguardd.sock",
        runtime: { valid: true, generation: 3 },
        permanent: { valid: true },
      });
    };

    const result = await getAgentGuardianStatus("/tmp/agentguardd.sock", fakeFetch);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Unexpected error result");
    }
    const payload = result.data as { runtime?: { generation?: number } };
    expect(payload.runtime?.generation).toBe(3);
  });

  test("validateAgentGuardianRules treats valid=false as business failure", async () => {
    const fakeFetch = async () =>
      createJsonResponse({
        scope: "permanent",
        state: {
          valid: false,
          error: "rewrite length mismatch",
        },
        message: "permanent ruleset is invalid",
      });

    const result = await validateAgentGuardianRules("permanent", "/tmp/agentguardd.sock", fakeFetch);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected error result");
    }
    expect(result.error).toContain("permanent ruleset is invalid");
  });

  test("reloadAgentGuardianRules preserves 422 payload for diagnosis", async () => {
    const fakeFetch = async () =>
      createJsonResponse(
        {
          error: "validate merged ruleset from /etc/agentguardian/rules.d: bad rule",
          message: "reload failed",
          runtime: { valid: true, generation: 2 },
          permanent: { valid: false, error: "bad rule" },
        },
        422,
      );

    const result = await reloadAgentGuardianRules("/tmp/agentguardd.sock", fakeFetch);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected error result");
    }
    expect(result.status).toBe(422);
    expect(result.error).toContain("bad rule");
    const payload = result.data as { runtime?: { generation?: number } };
    expect(payload.runtime?.generation).toBe(2);
  });
});
