# gleipnir

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run 
```

LLM config uses file instead of environment variables.

1. Create local config:

```bash
mkdir -p config
cp config/llm.example.json config/llm.json
```

2. Edit `config/llm.json` and fill your real `apiKey`.

You can provide either:
- `baseURL` directly
- or `host + apiPath` (for generic OpenAI-compatible providers)

Optional: override config path with `LLM_CONFIG_FILE`.

## Log RAG

The repository now includes a minimal log-oriented RAG pipeline for decoded AgentSight/OpenClaw logs.

Quick start:

```bash
python3 script/decode.py --input logs/oc.log --output logs/oc.decoded.ndjson
bun run log-rag:ingest -- --input logs/oc.decoded.ndjson
bun run log-rag:search -- --query "chat completions"
```

Further details:

- `doc/log-rag.md`
- `script/README.md`

This project was created using `bun init` in bun v1.3.10. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
