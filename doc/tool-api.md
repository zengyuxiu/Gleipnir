# AgentGuardian 当前功能总结与 Tool 调用 API 文档

本文基于当前仓库实现（`cmd/agentguardd` + `internal/control`）整理，目标是为上层 Agent/工具系统提供稳定的调用契约。

## 1. 当前功能总结

当前能力分为两层：

1. eBPF 执行层（数据面）
- `hide`：对命中策略的进程访问目标路径时返回类似 `ENOENT` 的效果。
- `rewrite`：对命中策略的进程读取目标文件内容时做等长字符串改写。

2. daemon 控制层（控制面）
- 进程：`agentguardd`
- 通信：Unix Socket + HTTP/JSON
- 状态模型：`permanent`（磁盘 `rules.d`）与 `runtime`（已下发到 BPF map 的内存快照）
- 支持控制动作：`status`、`validate`、`reload`

规则能力（YAML）：
- 每条规则必须设置且仅设置一个 selector：`match.pid` / `match.comm` / `match.exe`
- 动作类型：`hide` 或 `rewrite`
- `rewrite` 必须提供 `action.find` 与 `action.replace`，且二者长度相同

当前限制：
- `rewrite` 只覆盖 `read(2)` 路径
- `hide` 依赖内核 `lsm/file_open` 支持
- `match.exe` 通过扫描 `/proc` 扩展为 PID 策略，短生命周期进程存在竞态窗口

## 2. 控制面 API 概览

- Base: `http://unix`
- Socket: 默认 `/run/agentguardian/agentguardd.sock`
- Content-Type: `application/json`

可用 endpoint：

1. `GET /v1/status`
2. `POST /v1/validate?scope=permanent|runtime`（服务端也接受 `GET`）
3. `POST /v1/reload`

## 3. 数据结构

### 3.1 RulesetState

```json
{
  "scope": "permanent|runtime",
  "path": "/etc/agentguardian/rules.d",
  "loaded": true,
  "valid": true,
  "version": 1,
  "rule_count": 2,
  "pid_policy_count": 1,
  "comm_policy_count": 1,
  "generation": 3,
  "requires_process_sync": true,
  "updated_at": "2026-03-20T01:23:45Z",
  "error": ""
}
```

字段说明：
- `loaded`: 该 scope 是否已成功加载过规则
- `valid`: 该 scope 当前是否有效
- `generation`: 仅 runtime 有意义，每次成功下发策略后自增
- `requires_process_sync`: 规则是否包含 `match.exe`，若是则 daemon 会周期同步 PID
- `error`: 最近一次失败原因（空字符串或缺省表示无错误）

### 3.2 StatusResponse

```json
{
  "config_dir": "/etc/agentguardian",
  "rules_dir": "/etc/agentguardian/rules.d",
  "socket": "/run/agentguardian/agentguardd.sock",
  "runtime": { "...": "RulesetState" },
  "permanent": { "...": "RulesetState" }
}
```

### 3.3 ValidateResponse

```json
{
  "scope": "permanent",
  "state": { "...": "RulesetState" },
  "message": "permanent ruleset is valid"
}
```

### 3.4 ReloadResponse

```json
{
  "message": "reload applied permanent ruleset to runtime",
  "runtime": { "...": "RulesetState" },
  "permanent": { "...": "RulesetState" }
}
```

### 3.5 ErrorResponse

```json
{
  "error": "unsupported scope \"xxx\""
}
```

## 4. Endpoint 详细说明

### 4.1 查询状态

- Method: `GET`
- Path: `/v1/status`
- 返回码：
  - `200 OK`
  - `405 Method Not Allowed`

示例：

```bash
curl --unix-socket /run/agentguardian/agentguardd.sock \
  http://unix/v1/status
```

### 4.2 校验规则

- Method: `POST`（兼容 `GET`）
- Path: `/v1/validate`
- Query:
  - `scope`（可选）：`permanent` 或 `runtime`
  - 缺省时默认 `permanent`
- 返回码：
  - `200 OK`（即使校验失败，`valid=false` 仍返回 200）
  - `400 Bad Request`（scope 非法）
  - `405 Method Not Allowed`

示例：

```bash
curl --unix-socket /run/agentguardian/agentguardd.sock \
  -X POST "http://unix/v1/validate?scope=runtime"
```

### 4.3 重载规则到运行态

- Method: `POST`
- Path: `/v1/reload`
- 语义：读取并编译 `permanent`，成功后覆盖 `runtime` 并下发到 BPF map
- 返回码：
  - `200 OK`：重载成功
  - `422 Unprocessable Entity`：重载失败（例如规则非法、下发失败）
  - `405 Method Not Allowed`

`422` 响应体同时包含错误与状态快照：

```json
{
  "error": "validate merged ruleset from /etc/agentguardian/rules.d: ...",
  "message": "reload failed",
  "runtime": { "...": "RulesetState" },
  "permanent": { "...": "RulesetState" }
}
```

示例：

```bash
curl --unix-socket /run/agentguardian/agentguardd.sock \
  -X POST http://unix/v1/reload
```

## 5. Tool 调用契约（给 Agent/平台侧）

建议将控制面封装为 3 个工具：

1. `agentguardian.status`
- 输入：无
- 动作：`GET /v1/status`
- 输出：`StatusResponse`

2. `agentguardian.validate`
- 输入：`scope`（可选，`permanent|runtime`，默认 `permanent`）
- 动作：`POST /v1/validate?scope=...`
- 输出：`ValidateResponse`
- 失败判定建议：
  - HTTP 非 2xx 直接失败
  - HTTP 200 且 `state.valid=false` 视作业务失败（可读 `state.error`）

3. `agentguardian.reload`
- 输入：无
- 动作：`POST /v1/reload`
- 输出：`ReloadResponse`
- 失败判定建议：
  - HTTP 422 读取 `error` 并透传，同时保留 `runtime/permanent` 供诊断

## 6. 推荐调用流程

发布规则（`rules.d`）后，建议按以下顺序调用：

1. `validate(scope=permanent)`
2. `reload`
3. `status`（确认 `runtime.generation` 增长，且 `runtime.valid=true`）

针对 `match.exe` 规则，建议额外关注：
- `runtime.requires_process_sync=true`
- 进程启动后可能存在短暂同步延迟（默认同步周期 500ms）

## 7. 与 CLI 的映射

- `agctl status` -> `GET /v1/status`
- `agctl validate -scope permanent|runtime` -> `POST /v1/validate?scope=...`
- `agctl reload` -> `POST /v1/reload`

