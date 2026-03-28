# Gleipnir

[中文说明](./README.zh-CN.md)

Gleipnir is a Bun + Hono prototype for AI traffic observation, evidence retrieval, and safety control loops. The repository currently brings four capabilities together in one service:

- ReAct-style agent endpoints
- AgentSight event inspection and stream analysis tools
- Local SQLite/FTS-based Log RAG for evidence retrieval
- An OpenClaw security audit loop demo

The project is best understood as a backend capability prototype rather than a finished product. It already covers observation, retrieval, auditing, and part of the control plane, but it does not yet include production-grade rule staging, approval gates, rollback, or incident state management.

## Current Capabilities

### 1. Agent API

- `POST /chat`
  - General-purpose agent for Q&A, operational checks, and AgentGuardian / Log RAG tool usage
- `POST /agents/packet-analyzer/chat`
  - Packet-analysis agent focused on AgentSight request/response evidence and streaming diagnostics
- `DELETE /memory/:sessionId`
  - Clear session history

Implementation:

- [src/index.ts](./src/index.ts)
- [src/agent.ts](./src/agent.ts)
- [src/memory.ts](./src/memory.ts)

### 2. Tool Layer

The agent can currently call:

- `getAgentSightAiEvents`
  - Read AgentSight snapshot events and filter AI request/response traffic
- `getAgentSightAiEventsStream`
  - Read AgentSight SSE streams and filter AI request/response traffic
- `getAgentGuardianStatus`
  - Query AgentGuardian `permanent` and `runtime` state
- `validateAgentGuardianRules`
  - Validate AgentGuardian rules
- `reloadAgentGuardianRules`
  - Reload `permanent` rules into `runtime`
- `retrieveLogEvidence`
  - Search historical evidence in the local log evidence store

Implementation:

- [src/tools.ts](./src/tools.ts)

### 3. Log RAG

The current Log RAG implementation already supports:

- parsing AgentSight and decoded NDJSON
- extracting AI-related events into compact evidence documents
- storing evidence in local SQLite
- indexing evidence with SQLite FTS5
- exposing retrieval through CLI, HTTP APIs, and the tool layer

Entrypoints:

- `POST /rag/logs/ingest`
- `POST /rag/logs/search`
- `bun run log-rag:ingest`
- `bun run log-rag:search`

Implementation:

- [src/log-rag.ts](./src/log-rag.ts)
- [script/log-rag.ts](./script/log-rag.ts)
- [doc/log-rag.md](./doc/log-rag.md)

### 4. Security Audit Demo

The repository also includes an OpenClaw security loop demo that can:

- audit AI request/response summaries
- detect secret leaks and prompt injection patterns
- generate a simulated Guardian proposal
- simulate post-enforcement re-audit results

Entrypoint:

- `POST /demo/security-loop/run`

Implementation:

- [src/demo.ts](./src/demo.ts)
- [doc/security-audit-control-loop.md](./doc/security-audit-control-loop.md)

## Current Scope

What is already in place:

- HTTP service and core routes
- two agent modes: `general` and `packet-analysis`
- session memory backed by SQLite
- AgentSight snapshot and SSE stream readers
- AgentGuardian control-plane actions: `status`, `validate`, `reload`
- log evidence ingestion and retrieval
- security loop demo plus baseline tests

What is still missing:

- Guardian rule staging or writing tools
- a proposal-to-policy conversion layer
- rollback support
- incident lifecycle and audit trail management
- approval gates, dry-run flow, and dual control
- a unified UI for operators or product integration

## Quick Start

### 1. Install dependencies

```bash
bun install
```

### 2. Configure the model

```bash
mkdir -p config
cp config/llm.example.json config/llm.json
```

Edit `config/llm.json` and provide a real `apiKey`.

Two configuration styles are supported:

- provide `baseURL` directly
- or provide `host + apiPath`

By default the app reads `config/llm.json`. You can override the path with `LLM_CONFIG_FILE`.

### 3. Start the service

```bash
bun run dev
```

or:

```bash
bun run start
```

The server tries `3001`, `3002`, and `8787` by default. You can also set `PORT` explicitly.

## Common Commands

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

## API Examples

### Health Check

```bash
curl http://localhost:3001/
```

### General Agent

```bash
curl -X POST http://localhost:3001/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Check the current AgentGuardian rule status"
  }'
```

### Packet Analysis Agent

```bash
curl -X POST http://localhost:3001/agents/packet-analyzer/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Analyze recent AI responses and look for anomalies or secret leak signals"
  }'
```

### Ingest Log Evidence

```bash
curl -X POST http://localhost:3001/rag/logs/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "inputPath": "logs/oc.decoded.ndjson",
    "aiOnly": true
  }'
```

### Search Log Evidence

```bash
curl -X POST http://localhost:3001/rag/logs/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "secret leak",
    "limit": 5,
    "requestResponseType": "both"
  }'
```

### Run the Security Loop Demo

```bash
curl -X POST http://localhost:3001/demo/security-loop/run \
  -H "Content-Type: application/json" \
  -d '{
    "scenario": "openclaw-secret-leak"
  }'
```

## Repository Layout

```text
.
├── src/
│   ├── index.ts        # HTTP API entrypoint
│   ├── agent.ts        # agent runtime and profiles
│   ├── tools.ts        # AgentSight / AgentGuardian / Log RAG tools
│   ├── memory.ts       # SQLite-backed session memory
│   ├── log-rag.ts      # log evidence ingest and retrieval
│   └── demo.ts         # security audit loop demo
├── script/
│   ├── decode.py       # OpenClaw/AgentSight log decoder
│   └── log-rag.ts      # Log RAG CLI
├── config/
│   └── llm.example.json
└── doc/
    └── README.md       # documentation index
```

## Documentation

- [doc/README.md](./doc/README.md)
- [doc/react-agent-architecture.md](./doc/react-agent-architecture.md)
- [doc/tool-api.md](./doc/tool-api.md)
- [doc/log-rag.md](./doc/log-rag.md)
- [doc/security-audit-control-loop.md](./doc/security-audit-control-loop.md)
- [doc/sse-processor.md](./doc/sse-processor.md)

## Suggested Next Steps

1. Add Guardian rule staging.
   Introduce `stageGuardianRule` so proposals can be written into a validateable permanent ruleset and turned into a real `proposal -> validate -> reload` flow.

2. Introduce an incident state machine.
   Connect observation, audit, proposal, enforcement, and verification under one consistent lifecycle model.

3. Extract the demo audit logic into a reusable audit layer.
   Turn the current regex-based checks into configurable policies with scoring, false-positive handling, and versioning.

4. Strengthen the AgentSight evidence model.
   Unify snapshot and stream evidence shapes and make request/response/SSE-merged correlation keys explicit.

5. Stabilize external contracts.
   Lock down HTTP API shapes, tool schemas, and integration-facing documentation before building UI or broader automation on top.
