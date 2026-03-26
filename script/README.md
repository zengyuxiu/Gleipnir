# OpenClaw SSL Log Decoder

Decode `logs/oc.log` (with `HEX:` binary payloads) into readable NDJSON.

## Usage

```bash
python3 script/decode.py --input logs/oc.log --output logs/oc.decoded.ndjson
bun run log-rag:ingest -- --input logs/oc.decoded.ndjson
```

## Quick filter examples

Show WebSocket JSON frames:

```bash
rg '"frame"' logs/oc.decoded.ndjson
```

Show HTTP parser lines:

```bash
rg '"http"' logs/oc.decoded.ndjson
```

Search previously ingested evidence:

```bash
bun run log-rag:search -- --query "chat completions"
```
