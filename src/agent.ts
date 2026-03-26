import { createOpenAI } from "@ai-sdk/openai";
import { generateText, stepCountIs, type ModelMessage } from "ai";
import { z } from "zod";
import { memory } from "./memory";
import { tools } from "./tools";

type LLMConfig = {
  modelName: string;
  apiKey: string;
  baseURL: string | undefined;
};

const LLM_CONFIG_FILE = process.env.LLM_CONFIG_FILE ?? "config/llm.json";

const llmConfigFileSchema = z
  .object({
    model: z.string().min(1).default("gpt-4o-mini"),
    apiKey: z.string().min(1),
    baseURL: z.string().min(1).optional(),
    host: z.string().min(1).optional(),
    apiPath: z.string().min(1).default("/v1"),
  })
  .strict();

export type AgentResult = {
  sessionId: string;
  reply: string;
  mode: AgentMode;
};

export type AgentMode = "general" | "packet-analysis";

export type RunAgentOptions = {
  mode?: AgentMode;
};

type AgentProfile = {
  name: string;
  goal: string;
  reactLoop: string[];
  toolRouting: string[];
  answerRules: string[];
  stepLimit: number;
  temperature: number;
};

const agentProfiles: Record<AgentMode, AgentProfile> = {
  general: {
    name: "general-assistant",
    goal: "帮助用户完成通用问答、运维判断和工具调用，回答保持简洁可靠。",
    reactLoop: [
      "先理解用户目标，并判断是否缺少事实依据。",
      "若需要外部信息，调用最少但足够的工具获取事实。",
      "根据工具返回结果继续判断，必要时再做下一次工具调用。",
      "证据足够后停止调用工具，直接给出结论和建议。",
      "不要暴露内部思考过程，只输出结论、依据和建议。",
    ],
    toolRouting: [
      "当用户询问 AgentGuardian 的规则状态时，优先调用 getAgentGuardianStatus。",
      "当用户询问 AgentGuardian 规则是否有效时，优先调用 validateAgentGuardianRules。",
      "当用户要求重载 AgentGuardian 规则时，优先调用 reloadAgentGuardianRules。",
      "当用户询问历史日志、既往案例、incident 复盘证据时，优先调用 retrieveLogEvidence。",
    ],
    answerRules: [
      "如果工具调用失败，明确说明失败原因，不要编造结果。",
      "如果可以行动，就给出下一步可执行建议。",
      "回答尽量短，但要保留关键事实。",
    ],
    stepLimit: 5,
    temperature: 0.2,
  },
  "packet-analysis": {
    name: "packet-analysis-agent",
    goal: "分析 AgentSight 事件，定位 AI request/response 行为、异常和证据。",
    reactLoop: [
      "先识别用户关心的是最近事件、异常、请求响应还是流式数据。",
      "优先通过工具获取事实，再基于事件做判断。",
      "如需要实时或流式数据，优先调用流式工具；否则先用快照工具。",
      "证据足够后停止调用工具，整理成可执行结论。",
      "不要暴露内部思考过程，只输出结论、证据和排查建议。",
    ],
    toolRouting: [
      "如果用户问题涉及最近事件、请求响应、异常定位、包分析，优先调用 getAgentSightAiEvents。",
      "如果用户明确提到实时、流式、stream，优先调用 getAgentSightAiEventsStream。",
      "如果用户问题涉及历史样本、相似异常、日志证据回放，优先调用 retrieveLogEvidence。",
      "默认过滤参数建议：eventType=both, limit=50, includeRaw=false；若用户明确指定则按用户要求。",
    ],
    answerRules: [
      "回答尽量结构化，至少包含：结论概览、关键请求/响应证据、可疑点或异常、下一步排查建议。",
      "如果没有拿到有效事件，明确说明数据不足，并给出补充抓取建议。",
      "不要编造不存在的字段或事件。",
    ],
    stepLimit: 8,
    temperature: 0.1,
  },
};

function buildReActSystemPrompt(profile: AgentProfile): string {
  const sections = [
    `你是 ${profile.name}。`,
    `目标：${profile.goal}`,
    "请遵循 ReAct 工作方式，但不要输出内部推理，只保留最终结论。",
    "工作循环：",
    ...profile.reactLoop.map((item, index) => `${index + 1}. ${item}`),
    "工具路由：",
    ...profile.toolRouting.map((item, index) => `${index + 1}. ${item}`),
    "回答要求：",
    ...profile.answerRules.map((item, index) => `${index + 1}. ${item}`),
  ];

  return sections.join("\n");
}

function getAgentProfile(mode: AgentMode): AgentProfile {
  return agentProfiles[mode];
}

function normalizeBaseURL(raw: string): string {
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  return withProtocol.replace(/\/+$/, "");
}

function normalizeApiPath(raw: string): string {
  return raw.startsWith("/") ? raw : `/${raw}`;
}

async function loadLLMConfig(): Promise<
  { ok: true; config: LLMConfig } | { ok: false; error: string }
> {
  const file = Bun.file(LLM_CONFIG_FILE);
  if (!(await file.exists())) {
    return {
      ok: false,
      error: `未找到 LLM 配置文件：${LLM_CONFIG_FILE}`,
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(await file.text());
  } catch {
    return {
      ok: false,
      error: `LLM 配置文件不是合法 JSON：${LLM_CONFIG_FILE}`,
    };
  }

  const parsed = llmConfigFileSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const reason = parsed.error.issues.map((i) => i.message).join("; ");
    return {
      ok: false,
      error: `LLM 配置文件字段不合法：${reason}`,
    };
  }

  const data = parsed.data;
  const baseURLRaw = data.baseURL
    ? data.baseURL
    : data.host
      ? `${normalizeBaseURL(data.host)}${normalizeApiPath(data.apiPath)}`
      : undefined;

  const config: LLMConfig = {
    modelName: data.model,
    apiKey: data.apiKey,
    baseURL: baseURLRaw ? normalizeBaseURL(baseURLRaw) : undefined,
  };

  return { ok: true, config };
}

function resolveModelFromConfig(config: LLMConfig) {
  const provider = createOpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });
  return provider(config.modelName);
}

export async function runAgent(
  sessionId: string,
  userQuery: string,
  options: RunAgentOptions = {},
): Promise<AgentResult> {
  const llmConfigResult = await loadLLMConfig();
  const mode = options.mode ?? "general";
  const profile = getAgentProfile(mode);
  const query = userQuery.trim();
  if (query.length === 0) {
    return { sessionId, reply: "Message required", mode };
  }

  if (!llmConfigResult.ok) {
    return {
      sessionId,
      reply: `${llmConfigResult.error}。请先配置后再调用 agent。`,
      mode,
    };
  }
  const llmConfig = llmConfigResult.config;

  memory.addMessage(sessionId, "user", query);

  const history = memory.getHistory(sessionId, 20);
  const messages: ModelMessage[] = history.map((message) => ({
    role: message.role,
    content: message.content,
  }));

  const result = await generateText({
    model: resolveModelFromConfig(llmConfig),
    system: buildReActSystemPrompt(profile),
    messages,
    tools,
    stopWhen: stepCountIs(profile.stepLimit),
    temperature: profile.temperature,
  });

  const reply = result.text.trim();
  memory.addMessage(sessionId, "assistant", reply);

  return {
    sessionId,
    reply,
    mode,
  };
}
