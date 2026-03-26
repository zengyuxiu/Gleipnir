# Security Loop Demo

## Overview

This demo shows a runnable security loop for OpenClaw:

1. capture AI request / response
2. audit the captured content
3. create a Guardian fence proposal
4. simulate enforcement
5. re-audit the post-guard result

Important:

- this is a runnable demo
- it is self-contained
- Guardian enforcement is simulated
- real rule staging / rollback is not implemented yet in the current repo

## API

### Run the demo

`POST /demo/security-loop/run`

Request body:

```json
{
  "scenario": "openclaw-secret-leak"
}
```

Supported scenarios:

- `openclaw-secret-leak`
- `openclaw-safe`

Example:

```bash
curl -X POST http://localhost:3001/demo/security-loop/run \
  -H 'content-type: application/json' \
  -d '{"scenario":"openclaw-secret-leak"}'
```

## Expected behavior

### `openclaw-secret-leak`

- the demo simulates OpenClaw leaking a secret from `.env`
- audit marks it as `critical`
- the system creates a Guardian proposal
- enforcement is simulated as a file hide fence
- the second audit should drop to `allow`

### `openclaw-safe`

- the demo simulates a normal request / response
- audit returns `allow`
- no Guardian proposal is created

## Implementation mapping

- demo logic: `src/demo.ts`
- HTTP route: `src/index.ts`
- production design doc: `doc/security-audit-control-loop.md`

## Why simulated enforcement

The current repo has:

- AgentSight read tools
- AgentGuardian `status / validate / reload`

The current repo does not yet have:

- rule staging API
- rule write API
- rollback API

So this demo focuses on proving the control-loop shape first.
