# Gleipnir

[English README](./README.md)

Gleipnir 是一个面向 AI 流量观测、证据检索和安全控制闭环的 Bun + Hono 原型服务。当前仓库把四类能力放在同一个服务里：

- ReAct 风格的 agent 接口
- AgentSight 事件读取与流式分析工具
- 基于本地 SQLite/FTS 的 Log RAG 证据检索
- OpenClaw 安全审计闭环 demo

这个项目目前更适合被理解为“后端能力原型”，而不是完整产品。它已经覆盖了观测、检索、审计和一部分控制面，但还没有补齐生产环境需要的规则暂存、审批门禁、回滚和 incident 状态管理。

## 当前能力

### 1. Agent API

- `POST /chat`
  - 通用 agent，适合问答、运维判断，以及调用 AgentGuardian / Log RAG 工具
- `POST /agents/packet-analyzer/chat`
  - 面向 AgentSight 的包分析 agent，重点处理 request/response 证据和流式排障
- `DELETE /memory/:sessionId`
  - 清理会话历史

实现位置：

- [src/index.ts](./src/index.ts)
- [src/agent.ts](./src/agent.ts)
- [src/memory.ts](./src/memory.ts)

### 2. Tool 层

当前 agent 可调用：

- `getAgentSightAiEvents`
  - 读取 AgentSight 快照事件并过滤 AI request/response 流量
- `getAgentSightAiEventsStream`
  - 读取 AgentSight SSE 流并过滤 AI request/response 流量
- `getAgentGuardianStatus`
  - 查询 AgentGuardian 的 `permanent` 与 `runtime` 状态
- `validateAgentGuardianRules`
  - 校验 AgentGuardian 规则
- `reloadAgentGuardianRules`
  - 将 `permanent` 规则重载到 `runtime`
- `retrieveLogEvidence`
  - 从本地日志证据库中检索历史证据

实现位置：

- [src/tools.ts](./src/tools.ts)

### 3. Log RAG

当前 Log RAG 已支持：

- 解析 AgentSight 和 decoded NDJSON
- 提取 AI 相关事件为紧凑 evidence document
- 将证据存入本地 SQLite
- 通过 SQLite FTS5 建索引
- 通过 CLI、HTTP API 和 tool 层暴露检索能力

入口：

- `POST /rag/logs/ingest`
- `POST /rag/logs/search`
- `bun run log-rag:ingest`
- `bun run log-rag:search`

实现位置：

- [src/log-rag.ts](./src/log-rag.ts)
- [script/log-rag.ts](./script/log-rag.ts)
- [doc/log-rag.md](./doc/log-rag.md)

### 4. 安全审计 Demo

仓库中还包含一个 OpenClaw 安全闭环 demo，可以：

- 审计 AI request/response 摘要
- 检测 secret leak 与 prompt injection 模式
- 生成模拟的 Guardian 提案
- 模拟围栏生效后的复核结果

入口：

- `POST /demo/security-loop/run`

实现位置：

- [src/demo.ts](./src/demo.ts)
- [doc/security-audit-control-loop.md](./doc/security-audit-control-loop.md)

## 当前边界

已经具备：

- HTTP 服务与核心路由
- 两种 agent mode：`general` 与 `packet-analysis`
- SQLite 会话记忆
- AgentSight snapshot 与 SSE stream 读取
- AgentGuardian 控制面动作：`status`、`validate`、`reload`
- 日志证据入库与检索
- 安全闭环 demo 与基础测试

仍然缺少：

- Guardian 规则暂存或写入工具
- 提案到策略的转换层
- 回滚能力
- incident 生命周期与审计追踪
- 审批门禁、dry-run 和双人确认
- 面向运营或产品集成的统一 UI

## 快速开始

### 1. 安装依赖

```bash
bun install
```

### 2. 配置模型

```bash
mkdir -p config
cp config/llm.example.json config/llm.json
```

编辑 `config/llm.json`，填入真实的 `apiKey`。

支持两种配置方式：

- 直接提供 `baseURL`
- 或提供 `host + apiPath`

默认读取 `config/llm.json`，也可以通过 `LLM_CONFIG_FILE` 覆盖。

### 3. 启动服务

```bash
bun run dev
```

或：

```bash
bun run start
```

默认依次尝试 `3001`、`3002`、`8787`，也可以显式设置 `PORT`。

## 常用命令

```bash
bun run test
bun run typecheck
```

### Log RAG CLI

```bash
python3 script/decode.py --input logs/oc.log --output logs/oc.decoded.ndjson
bun run log-rag:ingest -- --input logs/oc.decoded.ndjson
bun run log-rag:search -- --query "chat completions"
```

## API 示例

### 健康检查

```bash
curl http://localhost:3001/
```

### 通用 Agent

```bash
curl -X POST http://localhost:3001/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "帮我检查 AgentGuardian 当前规则状态"
  }'
```

### 包分析 Agent

```bash
curl -X POST http://localhost:3001/agents/packet-analyzer/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "分析最近的 AI response，看看有没有异常或 secret leak 信号"
  }'
```

### 日志证据入库

```bash
curl -X POST http://localhost:3001/rag/logs/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "inputPath": "logs/oc.decoded.ndjson",
    "aiOnly": true
  }'
```

### 日志证据检索

```bash
curl -X POST http://localhost:3001/rag/logs/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "secret leak",
    "limit": 5,
    "requestResponseType": "both"
  }'
```

### 运行安全闭环 Demo

```bash
curl -X POST http://localhost:3001/demo/security-loop/run \
  -H "Content-Type: application/json" \
  -d '{
    "scenario": "openclaw-secret-leak"
  }'
```

## 仓库结构

```text
.
├── src/
│   ├── index.ts        # HTTP API 入口
│   ├── agent.ts        # agent runtime 与 profile
│   ├── tools.ts        # AgentSight / AgentGuardian / Log RAG 工具
│   ├── memory.ts       # 基于 SQLite 的会话记忆
│   ├── log-rag.ts      # 日志证据入库与检索
│   └── demo.ts         # 安全审计闭环 demo
├── script/
│   ├── decode.py       # OpenClaw/AgentSight 日志解码器
│   └── log-rag.ts      # Log RAG CLI
├── config/
│   └── llm.example.json
└── doc/
    └── README.md       # 文档索引
```

## 文档导航

- [doc/README.md](./doc/README.md)
- [doc/react-agent-architecture.md](./doc/react-agent-architecture.md)
- [doc/tool-api.md](./doc/tool-api.md)
- [doc/log-rag.md](./doc/log-rag.md)
- [doc/security-audit-control-loop.md](./doc/security-audit-control-loop.md)
- [doc/sse-processor.md](./doc/sse-processor.md)

## 建议的下一步

1. 增加 Guardian 规则暂存能力。
   新增 `stageGuardianRule`，让提案可以写入可校验的 permanent ruleset，形成真实的 `proposal -> validate -> reload` 流程。

2. 引入 incident 状态机。
   把观测、审计、提案、执行和复核统一到同一个生命周期模型里。

3. 将 demo 审计逻辑抽成可复用的审计层。
   把当前基于正则的检查升级成可配置策略，并支持评分、误报处理和版本管理。

4. 强化 AgentSight 证据模型。
   统一 snapshot 与 stream 的证据结构，并显式定义 request/response/SSE merged 的关联键。

5. 稳定外部契约。
   在继续做 UI 或更大范围自动化之前，先固定 HTTP API 结构、tool schema 和对集成方的文档说明。
