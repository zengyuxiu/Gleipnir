import { Hono } from "hono";
import { z } from "zod";
import { runAgent } from "./agent";
import { runSecurityAuditDemo } from "./demo";
import { ingestLogEvidenceFromFile, searchLogEvidence } from "./log-rag";
import { memory } from "./memory";

const app = new Hono();

const chatRequestSchema = z.object({
  message: z.string().min(1, "message cannot be empty"),
  sessionId: z.string().min(1).optional(),
});

const packetAnalyzeRequestSchema = z.object({
  message: z.string().min(1, "message cannot be empty"),
  sessionId: z.string().min(1).optional(),
});

const securityDemoRequestSchema = z.object({
  scenario: z.enum(["openclaw-secret-leak", "openclaw-safe"]).default("openclaw-secret-leak"),
});

const logRagIngestRequestSchema = z.object({
  inputPath: z.string().min(1, "inputPath cannot be empty"),
  sourceFile: z.string().min(1).optional(),
  aiOnly: z.boolean().default(true),
});

const logRagSearchRequestSchema = z.object({
  query: z.string().min(1, "query cannot be empty"),
  limit: z.number().int().min(1).max(20).default(5),
  requestResponseType: z.enum(["request", "response", "unknown", "both"]).default("both"),
  source: z.string().min(1).optional(),
  host: z.string().min(1).optional(),
  pathKeyword: z.string().min(1).optional(),
  includeRaw: z.boolean().default(false),
});

app.get("/", (c) => {
  return c.json({
    service: "gleipnir",
    status: "ok",
    now: new Date().toISOString(),
  });
});

app.post("/chat", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = chatRequestSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      {
        error: "Invalid request body",
        details: parsed.error.issues,
      },
      400,
    );
  }

  const sessionId = parsed.data.sessionId ?? crypto.randomUUID();

  try {
    const result = await runAgent(sessionId, parsed.data.message, {
      mode: "general",
    });
    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return c.json({ error: message }, 500);
  }
});

app.post("/agents/packet-analyzer/chat", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = packetAnalyzeRequestSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      {
        error: "Invalid request body",
        details: parsed.error.issues,
      },
      400,
    );
  }

  const baseSessionId = parsed.data.sessionId ?? crypto.randomUUID();
  const sessionId = `packet:${baseSessionId}`;

  try {
    const result = await runAgent(sessionId, parsed.data.message, {
      mode: "packet-analysis",
    });
    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return c.json({ error: message }, 500);
  }
});

app.post("/demo/security-loop/run", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = securityDemoRequestSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      {
        error: "Invalid request body",
        details: parsed.error.issues,
      },
      400,
    );
  }

  const result = runSecurityAuditDemo(parsed.data.scenario);
  return c.json(result);
});

app.post("/rag/logs/ingest", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = logRagIngestRequestSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      {
        error: "Invalid request body",
        details: parsed.error.issues,
      },
      400,
    );
  }

  try {
    const result = await ingestLogEvidenceFromFile(parsed.data.inputPath, {
      sourceFile: parsed.data.sourceFile,
      aiOnly: parsed.data.aiOnly,
    });
    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return c.json({ error: message }, 500);
  }
});

app.post("/rag/logs/search", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = logRagSearchRequestSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      {
        error: "Invalid request body",
        details: parsed.error.issues,
      },
      400,
    );
  }

  try {
    const result = searchLogEvidence(parsed.data);
    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return c.json({ error: message }, 500);
  }
});

app.delete("/memory/:sessionId", (c) => {
  const sessionId = c.req.param("sessionId");
  memory.clearSession(sessionId);
  return c.json({ ok: true, sessionId });
});

function isAddressInUseError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "EADDRINUSE"
  );
}

function startServer() {
  const preferredPorts = process.env.PORT
    ? [Number(process.env.PORT)]
    : [3001, 3002, 8787];

  for (const port of preferredPorts) {
    try {
      return Bun.serve({
        fetch: app.fetch,
        port,
      });
    } catch (error) {
      if (!isAddressInUseError(error)) {
        throw error;
      }
    }
  }

  throw new Error("No available port found. Please set PORT manually.");
}

if (import.meta.main) {
  const server = startServer();
  console.log(`Gleipnir API running on http://localhost:${server.port}`);
}

export default app;
