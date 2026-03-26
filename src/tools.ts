import { tool } from "ai";
import { z } from "zod";
import { searchLogEvidence } from "./log-rag";

const AGENTSIGHT_BASE_URL = "http://192.168.99.243:8089";
const AGENTSIGHT_EVENTS_API = `${AGENTSIGHT_BASE_URL}/api/events`;
const AGENTSIGHT_EVENTS_STREAM_API = `${AGENTSIGHT_BASE_URL}/api/events/stream`;
const AGENTGUARDIAN_BASE_URL = "http://unix";
const AGENTGUARDIAN_SOCKET_PATH = "/run/agentguardian/agentguardd.sock";

type UnixFetchInit = RequestInit & {
  unix?: string;
};

export type AgentSightEventType = "request" | "response" | "both";

export type AgentSightFetchParams = {
  eventType: AgentSightEventType;
  limit: number;
  keyword?: string;
  includeRaw: boolean;
};

export type AgentSightStreamFetchParams = AgentSightFetchParams & {
  timeoutMs: number;
};

type AgentSightFetchFn = (input: string, init?: RequestInit) => Promise<Response>;
type AgentGuardianFetchFn = (input: string, init?: UnixFetchInit) => Promise<Response>;

type AgentGuardianAction = "status" | "validate" | "reload";
type AgentGuardianScope = "permanent" | "runtime";

export type AgentGuardianResult =
  | {
      ok: true;
      action: AgentGuardianAction;
      socketPath: string;
      status: number;
      data: unknown;
    }
  | {
      ok: false;
      action: AgentGuardianAction;
      socketPath: string;
      status?: number;
      error: string;
      data?: unknown;
    };

export type AgentSightEventItem = {
  timestamp: unknown | null;
  source: unknown | null;
  comm: unknown | null;
  requestResponseType: "request" | "response" | "unknown";
  messageType?: unknown | null;
  method: unknown | null;
  path: unknown | null;
  statusCode: unknown | null;
  function?: unknown | null;
  eventCount?: unknown | null;
  summary: string;
  raw?: unknown;
};

export type AgentSightFetchSuccess = {
  ok: true;
  apiUrl: string;
  totalEvents: number;
  matchedEvents: number;
  returnedEvents: number;
  items: AgentSightEventItem[];
};

export type AgentSightFetchFailure = {
  ok: false;
  apiUrl: string;
  error: string;
};

export type AgentSightFetchResult = AgentSightFetchSuccess | AgentSightFetchFailure;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function parseEventsPayload(rawText: string): unknown[] {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Fall through to JSONL parsing.
  }

  const events: unknown[] = [];
  for (const line of rawText.split("\n")) {
    const t = line.trim();
    if (t.length === 0) {
      continue;
    }
    try {
      events.push(JSON.parse(t));
    } catch {
      // Skip invalid lines to keep tool stable.
    }
  }
  return events;
}

function classifyRequestResponse(event: unknown): "request" | "response" | "unknown" {
  const e = asRecord(event);
  const d = asRecord(e.data);
  const source = String(e.source ?? "").toLowerCase();

  if (source === "sse_processor") {
    return "response";
  }

  const messageType = String(d.message_type ?? d.type ?? "").toLowerCase();
  if (messageType === "request" || messageType === "req") {
    return "request";
  }
  if (messageType === "response" || messageType === "res" || messageType === "respond") {
    return "response";
  }

  if (typeof d.method === "string" && d.method.length > 0 && d.status_code == null) {
    return "request";
  }
  if (typeof d.status_code === "number") {
    return "response";
  }

  if (source === "ssl") {
    const fn = String(d.function ?? "").toUpperCase();
    if (fn === "WRITE/SEND") {
      return "request";
    }
    if (fn === "READ/RECV") {
      return "response";
    }
  }

  return "unknown";
}

function looksLikeAiPath(path: string): boolean {
  const p = path.toLowerCase();
  return (
    p.includes("/v1/messages") ||
    p.includes("/v1/chat/completions") ||
    p.includes("/v1/responses") ||
    p.includes("/chat/completions")
  );
}

function looksLikeAiHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h.includes("openai.com") ||
    h.includes("anthropic.com") ||
    h.includes("claude.ai") ||
    h.includes("deepseek.com") ||
    h.includes("modelscope") ||
    h.includes("aliyuncs.com")
  );
}

function isAiRelatedEvent(event: unknown): boolean {
  const e = asRecord(event);
  const d = asRecord(e.data);
  const source = String(e.source ?? "").toLowerCase();

  if (source === "sse_processor") {
    return true;
  }

  if (source === "http_parser") {
    const path = String(d.path ?? "");
    const headers = asRecord(d.headers);
    const host = String(headers.host ?? "");
    return looksLikeAiPath(path) || looksLikeAiHost(host);
  }

  if (source === "ssl") {
    const payload = d.data;
    if (typeof payload === "string" && payload.startsWith("HEX:")) {
      return false;
    }
  }

  const blob = JSON.stringify(event).toLowerCase();
  const aiKeywords = [
    "openai",
    "anthropic",
    "claude",
    "gpt",
    "llm",
    "assistant",
    "/v1/messages",
    "/v1/chat/completions",
    "sse_processor",
    "message_start",
    "content_block_delta",
  ];
  return aiKeywords.some((k) => blob.includes(k));
}

function eventSummary(event: unknown): string {
  const e = asRecord(event);
  const d = asRecord(e.data);
  const firstLine = d.first_line;
  if (typeof firstLine === "string" && firstLine.length > 0) {
    return firstLine;
  }
  const textContent = d.text_content;
  if (typeof textContent === "string" && textContent.length > 0) {
    return textContent.slice(0, 160);
  }
  const eventName = d.event;
  if (typeof eventName === "string" && eventName.length > 0) {
    return eventName;
  }
  return "n/a";
}

function toFetchSuccess(
  allEvents: unknown[],
  params: AgentSightFetchParams,
  apiUrl: string,
): AgentSightFetchSuccess {
  const loweredKeyword = params.keyword?.toLowerCase();

  const filtered = allEvents.filter((event) => {
    if (!isAiRelatedEvent(event)) {
      return false;
    }

    const rrType = classifyRequestResponse(event);
    if (params.eventType !== "both" && rrType !== params.eventType) {
      return false;
    }

    if (!loweredKeyword) {
      return true;
    }
    return JSON.stringify(event).toLowerCase().includes(loweredKeyword);
  });

  const picked: AgentSightEventItem[] = filtered.slice(-params.limit).map((event) => {
    const e = asRecord(event);
    const d = asRecord(e.data);
    const item = {
      timestamp: e.timestamp ?? null,
      source: e.source ?? null,
      comm: e.comm ?? null,
      requestResponseType: classifyRequestResponse(event),
      messageType: d.message_type ?? d.type ?? null,
      method: d.method ?? null,
      path: d.path ?? null,
      statusCode: d.status_code ?? null,
      function: d.function ?? null,
      eventCount: d.event_count ?? null,
      summary: eventSummary(event),
    };
    if (!params.includeRaw) {
      return item;
    }
    return {
      ...item,
      raw: event,
    };
  });

  return {
    ok: true,
    apiUrl,
    totalEvents: allEvents.length,
    matchedEvents: filtered.length,
    returnedEvents: picked.length,
    items: picked,
  };
}

function parseSseEventBlock(block: string): unknown[] {
  const trimmed = block.trim();
  if (trimmed.length === 0 || trimmed.startsWith(":")) {
    return [];
  }

  const dataLines: string[] = [];
  const lines = block.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  const payload = (dataLines.length > 0 ? dataLines.join("\n") : trimmed).trim();
  if (payload.length === 0 || payload === "[DONE]") {
    return [];
  }

  return parseEventsPayload(payload);
}

async function readSseJsonEvents(response: Response): Promise<unknown[]> {
  if (!response.body) {
    return parseEventsPayload(await response.text());
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const allEvents: unknown[] = [];
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split(/\r?\n\r?\n/);
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        allEvents.push(...parseSseEventBlock(chunk));
      }
    }
  } catch {
    // Most likely timeout/cancel on long-running stream.
    // Keep already accumulated events for best-effort analysis.
  } finally {
    reader.releaseLock();
  }

  buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    allEvents.push(...parseSseEventBlock(buffer));
  }

  return allEvents;
}

function normalizeTimeoutMs(raw: number): number {
  if (!Number.isFinite(raw)) {
    return 5000;
  }
  return Math.max(1000, Math.min(60000, Math.floor(raw)));
}

function parseJsonPayload(rawText: string): unknown {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return rawText;
  }
}

function getErrorMessage(payload: unknown, fallback: string): string {
  const record = asRecord(payload);
  const error = record.error;
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  const message = record.message;
  if (typeof message === "string" && message.length > 0) {
    return message;
  }
  return fallback;
}

async function callAgentGuardian(
  action: AgentGuardianAction,
  path: string,
  init: UnixFetchInit,
  fetchFn: AgentGuardianFetchFn = fetch,
): Promise<AgentGuardianResult> {
  const socketPath = init.unix ?? AGENTGUARDIAN_SOCKET_PATH;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const resp = await fetchFn(`${AGENTGUARDIAN_BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(init.headers ?? {}),
      },
      unix: socketPath,
    });

    const rawText = await resp.text();
    const payload = parseJsonPayload(rawText);

    if (!resp.ok) {
      return {
        ok: false,
        action,
        socketPath,
        status: resp.status,
        error: getErrorMessage(payload, `HTTP ${resp.status} ${resp.statusText}`),
        data: payload,
      };
    }

    return {
      ok: true,
      action,
      socketPath,
      status: resp.status,
      data: payload,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      action,
      socketPath,
      error: message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchAgentSightAiEvents(
  { eventType, limit, keyword, includeRaw }: AgentSightFetchParams,
  fetchFn: AgentSightFetchFn = fetch,
): Promise<AgentSightFetchResult> {
  const apiUrl = process.env.AGENTSIGHT_API_URL ?? AGENTSIGHT_EVENTS_API;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let responseText = "";

  try {
    const resp = await fetchFn(apiUrl, { signal: controller.signal });
    if (!resp.ok) {
      return {
        ok: false,
        apiUrl,
        error: `HTTP ${resp.status} ${resp.statusText}`,
      };
    }
    responseText = await resp.text();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      apiUrl,
      error: msg,
    };
  } finally {
    clearTimeout(timeout);
  }

  const allEvents = parseEventsPayload(responseText);
  return toFetchSuccess(allEvents, { eventType, limit, keyword, includeRaw }, apiUrl);
}

export async function fetchAgentSightAiEventsStream(
  { eventType, limit, keyword, includeRaw, timeoutMs }: AgentSightStreamFetchParams,
  fetchFn: AgentSightFetchFn = fetch,
): Promise<AgentSightFetchResult> {
  const apiUrl = process.env.AGENTSIGHT_STREAM_API_URL ?? AGENTSIGHT_EVENTS_STREAM_API;
  const effectiveTimeoutMs = normalizeTimeoutMs(timeoutMs);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), effectiveTimeoutMs);

  try {
    const resp = await fetchFn(apiUrl, {
      signal: controller.signal,
      headers: {
        accept: "text/event-stream",
      },
    });

    if (!resp.ok) {
      return {
        ok: false,
        apiUrl,
        error: `HTTP ${resp.status} ${resp.statusText}`,
      };
    }
    const allEvents = await readSseJsonEvents(resp);
    return toFetchSuccess(allEvents, { eventType, limit, keyword, includeRaw }, apiUrl);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      apiUrl,
      error: msg,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function getAgentGuardianStatus(
  socketPath = AGENTGUARDIAN_SOCKET_PATH,
  fetchFn: AgentGuardianFetchFn = fetch,
): Promise<AgentGuardianResult> {
  return callAgentGuardian(
    "status",
    "/v1/status",
    {
      method: "GET",
      unix: socketPath,
    },
    fetchFn,
  );
}

export async function validateAgentGuardianRules(
  scope: AgentGuardianScope = "permanent",
  socketPath = AGENTGUARDIAN_SOCKET_PATH,
  fetchFn: AgentGuardianFetchFn = fetch,
): Promise<AgentGuardianResult> {
  const result = await callAgentGuardian(
    "validate",
    `/v1/validate?scope=${scope}`,
    {
      method: "POST",
      unix: socketPath,
    },
    fetchFn,
  );

  if (!result.ok) {
    return result;
  }

  const payload = asRecord(result.data);
  const state = asRecord(payload.state);
  if (state.valid === false) {
    return {
      ok: false,
      action: "validate",
      socketPath,
      status: result.status,
      error: getErrorMessage(result.data, "ruleset validation failed"),
      data: result.data,
    };
  }

  return result;
}

export async function reloadAgentGuardianRules(
  socketPath = AGENTGUARDIAN_SOCKET_PATH,
  fetchFn: AgentGuardianFetchFn = fetch,
): Promise<AgentGuardianResult> {
  return callAgentGuardian(
    "reload",
    "/v1/reload",
    {
      method: "POST",
      unix: socketPath,
    },
    fetchFn,
  );
}

export function retrieveLogEvidence(params: {
  query: string;
  limit: number;
  requestResponseType?: "request" | "response" | "unknown" | "both";
  source?: string;
  host?: string;
  pathKeyword?: string;
  includeRaw: boolean;
}) {
  return searchLogEvidence(params);
}

export const getAgentSightAiEventsTool = tool({
  description: "从 AgentSight 拉取事件，并过滤 AI request/response 相关 event。",
  inputSchema: z.object({
    eventType: z
      .enum(["request", "response", "both"])
      .default("both")
      .describe("筛选 request、response 或两者"),
    limit: z.number().int().min(1).max(200).default(50).describe("最多返回多少条"),
    keyword: z.string().optional().describe("可选关键词二次过滤"),
    includeRaw: z.boolean().default(false).describe("是否返回原始事件"),
  }),
  execute: async ({ eventType, limit, keyword, includeRaw }) => {
    return fetchAgentSightAiEvents({
      eventType,
      limit,
      keyword,
      includeRaw,
    });
  },
});

export const getAgentSightAiEventsStreamTool = tool({
  description: "从 AgentSight SSE 流接口拉取事件，并过滤 AI request/response 相关 event。",
  inputSchema: z.object({
    eventType: z
      .enum(["request", "response", "both"])
      .default("both")
      .describe("筛选 request、response 或两者"),
    limit: z.number().int().min(1).max(200).default(50).describe("最多返回多少条"),
    keyword: z.string().optional().describe("可选关键词二次过滤"),
    includeRaw: z.boolean().default(false).describe("是否返回原始事件"),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(60000)
      .default(5000)
      .describe("流式抓取超时时间（毫秒）"),
  }),
  execute: async ({ eventType, limit, keyword, includeRaw, timeoutMs }) => {
    return fetchAgentSightAiEventsStream({
      eventType,
      limit,
      keyword,
      includeRaw,
      timeoutMs,
    });
  },
});

export const getAgentGuardianStatusTool = tool({
  description: "通过 AgentGuardian 的 Unix Socket 查询当前 permanent/runtime 规则状态。",
  inputSchema: z.object({
    socketPath: z
      .string()
      .default(AGENTGUARDIAN_SOCKET_PATH)
      .describe("AgentGuardian Unix Socket 路径"),
  }),
  execute: async ({ socketPath }) => {
    return getAgentGuardianStatus(socketPath);
  },
});

export const validateAgentGuardianRulesTool = tool({
  description: "校验 AgentGuardian 规则，默认校验 permanent。",
  inputSchema: z.object({
    scope: z
      .enum(["permanent", "runtime"])
      .default("permanent")
      .describe("要校验的规则作用域"),
    socketPath: z
      .string()
      .default(AGENTGUARDIAN_SOCKET_PATH)
      .describe("AgentGuardian Unix Socket 路径"),
  }),
  execute: async ({ scope, socketPath }) => {
    return validateAgentGuardianRules(scope, socketPath);
  },
});

export const reloadAgentGuardianRulesTool = tool({
  description: "将 AgentGuardian permanent 规则重载到 runtime 并下发。",
  inputSchema: z.object({
    socketPath: z
      .string()
      .default(AGENTGUARDIAN_SOCKET_PATH)
      .describe("AgentGuardian Unix Socket 路径"),
  }),
  execute: async ({ socketPath }) => {
    return reloadAgentGuardianRules(socketPath);
  },
});

export const retrieveLogEvidenceTool = tool({
  description:
    "从本地日志证据库检索历史 AI request/response、SSE merged response 和排障证据，适合做 case recall 和 incident 对比。",
  inputSchema: z.object({
    query: z.string().min(1).describe("检索关键词或问题"),
    limit: z.number().int().min(1).max(20).default(5).describe("最多返回多少条证据"),
    requestResponseType: z
      .enum(["request", "response", "unknown", "both"])
      .default("both")
      .describe("按请求/响应方向过滤"),
    source: z.string().optional().describe("可选 source 精确过滤"),
    host: z.string().optional().describe("可选 host 模糊过滤"),
    pathKeyword: z.string().optional().describe("可选 path 模糊过滤"),
    includeRaw: z.boolean().default(false).describe("是否返回原始日志 JSON"),
  }),
  execute: async ({ query, limit, requestResponseType, source, host, pathKeyword, includeRaw }) => {
    return retrieveLogEvidence({
      query,
      limit,
      requestResponseType,
      source,
      host,
      pathKeyword,
      includeRaw,
    });
  },
});

export const tools = {
  getAgentSightAiEvents: getAgentSightAiEventsTool,
  getAgentSightAiEventsStream: getAgentSightAiEventsStreamTool,
  getAgentGuardianStatus: getAgentGuardianStatusTool,
  validateAgentGuardianRules: validateAgentGuardianRulesTool,
  reloadAgentGuardianRules: reloadAgentGuardianRulesTool,
  retrieveLogEvidence: retrieveLogEvidenceTool,
} as const;
