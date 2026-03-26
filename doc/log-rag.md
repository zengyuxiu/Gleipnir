# Log RAG

## Overview

This project now includes a minimal log-oriented RAG pipeline designed for AI traffic analysis and incident recall.

Current scope:

- Normalize decoded NDJSON logs into compact evidence documents
- Store evidence in local SQLite
- Build an SQLite FTS5 index for keyword/BM25-style retrieval
- Expose retrieval through both HTTP APIs and the agent tool layer

Deliberately out of scope for this first version:

- Remote embedding services
- External vector databases
- Automatic long-term storage of unconfirmed conclusions

That boundary matches the guidance in `doc/security-audit-control-loop.md`: store compressed evidence and confirmed conclusions, not transient guesses.

## Data Flow

Recommended pipeline:

1. Capture raw AgentSight/OpenClaw logs
2. Decode raw SSL payloads into readable NDJSON with `script/decode.py`
3. Ingest decoded NDJSON into the local evidence store
4. Search the evidence store from API calls or `retrieveLogEvidence`

```text
raw log -> decoded ndjson -> evidence docs -> sqlite fts -> agent/tool retrieval
```

## Evidence Schema

Each indexed evidence document stores:

- `source_file`
- `source_line`
- `timestamp`
- `source`
- `comm`
- `request_response_type`
- `host`
- `method`
- `path`
- `status_code`
- `message_id`
- `connection_id`
- `summary`
- `content`
- `tags`
- `raw_json`

Design intent:

- `summary` is short and retrieval-friendly
- `content` is the compressed evidence text used for search
- `raw_json` preserves the original event for drill-down
- `tags` keep cheap structured hints for filtering and ranking

## Supported Input Shapes

The ingester accepts both:

- Raw AgentSight-style NDJSON with `data.*`
- Decoded NDJSON produced by `script/decode.py`, including `http.*` and `decoded.*`

This lets you ingest either live snapshots or preprocessed packet logs without writing a second parser.

## CLI Usage

### 1. Decode logs

```bash
python3 script/decode.py --input logs/oc.log --output logs/oc.decoded.ndjson
```

### 2. Ingest evidence

```bash
bun run log-rag:ingest -- --input logs/oc.decoded.ndjson
```

Optional flags:

- `--source-file <label>` overrides the stored source label
- `--all-events` disables AI-only filtering

### 3. Search evidence

```bash
bun run log-rag:search -- --query "chat completions" --limit 5
```

Optional flags:

- `--request-type request|response|unknown|both`
- `--source <source>`
- `--host <host>`
- `--path-keyword <path>`
- `--include-raw`

## HTTP APIs

### Ingest

`POST /rag/logs/ingest`

```json
{
  "inputPath": "logs/oc.decoded.ndjson",
  "aiOnly": true
}
```

### Search

`POST /rag/logs/search`

```json
{
  "query": "secret leak",
  "limit": 5,
  "requestResponseType": "both",
  "source": "sse_processor",
  "includeRaw": false
}
```

## Agent Integration

The agent now exposes `retrieveLogEvidence`.

Use it when the question is about:

- historical incidents
- similar past failures
- previous request/response evidence
- replaying known packet patterns

Suggested pattern:

1. Use `getAgentSightAiEvents` for fresh/live facts
2. Use `retrieveLogEvidence` for historical recall
3. Compare the new event against past evidence before drawing a conclusion

## Retrieval Strategy

This first version uses hybrid-lite retrieval:

- structured filters on `source`, `host`, `path`, `request_response_type`
- SQLite FTS5 for text lookup over `summary`, `content`, and `tags`
- fallback `LIKE` matching if FTS is unavailable

This is intentionally simpler than full vector RAG, but it is much more stable for logs because:

- request paths, status codes, and method names are highly lexical
- incident patterns often contain exact error strings
- log evidence benefits from deterministic filters before semantic expansion

## Future Extension

When you are ready to add embeddings, keep this layout and add a second index layer rather than replacing it:

1. keep the current structured evidence docs
2. generate embeddings only for `summary` and compressed `content`
3. query with filter-first, then vector recall, then rerank
4. never embed raw noisy fragments directly

That preserves the current operational safety while improving fuzzy recall later.
