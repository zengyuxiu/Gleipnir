# OpenClaw Security Audit Control Loop

## 1. Goal

目标是构建一个闭环安全 agent：

1. 使用 AgentSight tool 捕获 OpenClaw 的 AI request / response
2. 对流量进行安全与合规审计
3. 调用 AgentGuardian tool 提供安全围栏
4. 再次观测流量
5. 再次审计并判断风险是否下降
6. 持续循环，直到风险收敛或升级给人工

这个目标是可行的，但在生产环境下不能做成“看到风险就立刻自动封堵”的单步流程，而应该做成带门禁的控制闭环。

## 2. Current project capability vs target

当前仓库已经具备的基础能力：

- `src/tools.ts`
  - AgentSight 读取能力
  - AgentGuardian `status / validate / reload`
- `src/agent.ts`
  - ReAct agent profile
  - 可基于工具形成观测 -> 行动 -> 复核链路

当前还缺的关键能力：

- 还没有“生成或写入 Guardian 规则”的 tool
- 还没有“风险评估结果 -> 规则模板”的转换层
- 还没有“自动回滚”的 tool
- 还没有“审计事件、策略变更、复核结果”的统一 incident 状态机
- 还没有“人工审批 / 双人确认 / dry-run”门禁

所以，当前系统适合做“观察 + 判断 + 校验 + 重载已有规则”，但还不适合直接在生产环境里全自动封堵。

## 3. Recommended production architecture

建议拆成 6 个职责清晰的层：

### 3.1 Observe Layer

职责：

- 从 AgentSight 拉取 OpenClaw 相关事件
- 合并 request / response / stream 片段
- 形成可审计证据

建议输出：

- `incident_id`
- `session_key`
- `provider`
- `request_summary`
- `response_summary`
- `raw_event_refs`
- `risk_signals`
- `captured_at`

### 3.2 Audit Layer

职责：

- 判断是否命中安全或合规风险
- 输出标准化风险评级

建议评级：

- `info`
- `low`
- `medium`
- `high`
- `critical`

建议审计维度：

- 敏感数据泄露
- 凭证 / token 泄露
- 越权调用
- 高风险提示词注入
- 不合规数据输出
- 非预期外联目标
- 工具调用异常

### 3.3 Policy Planning Layer

职责：

- 根据风险结果生成候选围栏策略
- 不直接下发，只生成“变更提案”

建议输出：

- `proposal_id`
- `incident_id`
- `target_selector`
- `proposed_action`
- `expected_effect`
- `blast_radius`
- `rollback_plan`

注意：

- 这一层不能直接操作 AgentGuardian runtime
- 这一层只负责生成建议规则和影响评估

### 3.4 Guard Execution Layer

职责：

- 校验规则
- 应用规则
- 查询状态

建议拆成独立工具：

- `stageGuardianRule`
- `validateAgentGuardianRules`
- `reloadAgentGuardianRules`
- `getAgentGuardianStatus`
- `rollbackGuardianRule`

当前仓库只具备后 3 个中的一部分能力，`stageGuardianRule` 和 `rollbackGuardianRule` 仍需补充。

### 3.5 Verification Layer

职责：

- 在围栏生效后再次采样和审计
- 比较变更前后风险指标

建议输出：

- `blocked_effective`
- `risk_before`
- `risk_after`
- `new_side_effects`
- `needs_rollback`

### 3.6 Governance Layer

职责：

- 决定哪些风险可以自动封堵
- 哪些必须人工审批
- 哪些需要升级给 on-call / security

推荐规则：

- `low` 和 `medium` 可以先 dry-run
- `high` 需要人工确认
- `critical` 可以执行预定义 emergency rule，但必须自动触发复核和回滚窗口

## 4. Recommended control loop

推荐的生产闭环不是简单循环，而是状态机：

1. `DETECTED`
2. `EVIDENCE_BUILT`
3. `AUDITED`
4. `PROPOSAL_CREATED`
5. `VALIDATED`
6. `APPROVED`
7. `ENFORCED`
8. `REAUDIT_PENDING`
9. `VERIFIED`
10. `CLOSED` 或 `ROLLED_BACK` 或 `ESCALATED`

推荐执行链路：

1. AgentSight 捕获 OpenClaw 包
2. 归并 request / response 并提取证据
3. 审计 agent 输出风险等级与原因
4. 风险高于阈值时生成 Guardian 规则提案
5. 先 `validate`
6. 通过审批后再 `reload`
7. 再次抓取 OpenClaw 流量
8. 重新审计
9. 若风险下降且无副作用，关闭 incident
10. 若副作用过大或封堵无效，回滚并升级人工

## 5. Production rollout plan

建议分 4 个阶段上线，而不是一步全自动：

### Phase 1: Observe only

- 只抓包
- 只审计
- 不封堵
- 收集误报率和漏报率

### Phase 2: Recommend only

- agent 输出封堵建议
- 不自动执行
- 由人工执行或审批

### Phase 3: Guarded automation

- 仅对低爆炸半径规则自动执行
- 必须有回滚
- 必须有二次审计

### Phase 4: Selective autonomy

- 对特定已验证场景开启自动封堵
- 例如固定 provider、固定 path、固定高风险模式

## 6. Key production problems

下面这些问题是真正会在生产环境里出现的。

### 6.1 Tool conflict: read tools vs write tools

问题：

- AgentSight 是观测工具
- AgentGuardian 是变更工具
- 如果一个 agent 在同一轮里同时做“观察”和“写策略”，容易基于不完整证据做错误动作

建议：

- 强制两阶段执行
- 先审计，后变更
- 写工具只能由 `approved proposal` 驱动

### 6.2 Stale observation

问题：

- 审计依据可能已经过时
- 新一轮包已经出现，但 agent 还在用旧证据判断

建议：

- 所有 proposal 必须绑定 `incident_id` 和证据时间窗
- 超过时间窗必须重新取证

### 6.3 Stream vs snapshot inconsistency

问题：

- SSE stream 和快照事件可能不一致
- 流式 response 可能尚未完整合并

建议：

- 对流式审计必须优先使用已归并的 `sse_processor`
- 在规则执行前做一次短时间窗口重采样

### 6.4 Duplicate or conflicting rules

问题：

- 多个 agent 可能对同一目标生成重复规则
- 一条 `rewrite` 和另一条 `hide` 可能互相覆盖或产生不可预测行为

建议：

- 建立规则指纹
- 对 selector + action 做去重
- 在 proposal 阶段做冲突检查

### 6.5 Self-blocking

问题：

- 规则可能把 AgentSight、自身 agent、AgentGuardian daemon 或运维进程一起封掉

建议：

- 内置永不封堵名单
- 例如 `agentguardd`、采集进程、审计 agent 自身

### 6.6 Control loop oscillation

问题：

- 封堵后风险下降
- agent 又放开
- 下一轮风险再次上升
- 系统进入震荡

建议：

- 引入最小生效时间
- 引入冷却时间
- 没有人为确认时，不允许频繁切换规则状态

### 6.7 False positive from incomplete payloads

问题：

- 二进制片段、截断包、缺失上下文会导致误判

建议：

- 风险评分要带置信度
- 低置信度不能直接触发封堵

### 6.8 `match.exe` race window

问题：

- `match.exe` 依赖 `/proc` 扫描转 PID
- 短生命周期进程可能在同步前已结束或已发出请求

建议：

- 对高风险封堵优先使用 `comm` 或稳定 selector
- 对 `match.exe` 场景加入额外复核

### 6.9 No current mutation API for rule creation

问题：

- 当前控制面文档只提供 `status / validate / reload`
- 没有直接创建规则的 API

建议：

- 不要让 agent 直接写系统目录
- 生产方案应通过独立规则提案服务、GitOps 或受控变更 API 来写入 `rules.d`

### 6.10 RAG contamination

问题：

- 如果把错误审计结论直接写入长期 RAG，会污染后续判断

建议：

- RAG 只存压缩证据和经过确认的结论
- 未确认 incident 只能写入短期工作记忆

## 7. Recommended tool boundaries

生产环境下，工具边界必须清晰：

### Read-only tools

- `getAgentSightAiEvents`
- `getAgentSightAiEventsStream`
- `getAgentGuardianStatus`

### Analyze tools

- `buildAuditEvidence`
- `evaluateOpenClawRisk`
- `compareBeforeAfterRisk`

### Change tools

- `stageGuardianRule`
- `validateAgentGuardianRules`
- `reloadAgentGuardianRules`
- `rollbackGuardianRule`

### Governance tools

- `approveProposal`
- `rejectProposal`
- `openIncident`
- `closeIncident`

原则：

- 一个 tool 最好只做一类事
- 不要让同一个 tool 同时“分析 + 执行封堵”
- 否则排障和权限控制都会非常痛苦

## 8. Recommended agent split

建议不要只有一个全能 agent，而是至少分成 3 个角色：

### 8.1 Observer Agent

职责：

- 调用 AgentSight tools
- 构建证据
- 不具备变更权限

### 8.2 Auditor Agent

职责：

- 对证据做安全和合规审计
- 输出风险评级和封堵建议
- 不直接执行策略

### 8.3 Enforcer Agent

职责：

- 只处理已审批的 proposal
- 调用 Guardian validate / reload / rollback
- 回传执行结果

如果只保留一个 agent，也必须在逻辑上把这三种职责隔离开。

## 9. Recommended production safeguards

必须具备以下保护：

- 审批门禁
- dry-run 模式
- 规则回滚
- 审计日志
- 规则指纹和幂等控制
- 永不封堵名单
- 冷却时间
- 证据时间窗校验
- 变更后的自动复审

## 10. Practical implementation path for this repo

结合当前仓库，建议按下面顺序做：

1. 保留现有 AgentSight 读取和 AgentGuardian 状态类工具
2. 新增 `buildAuditEvidence`，把 OpenClaw request / response 归并成审计证据
3. 新增 `evaluateOpenClawRisk`，输出标准化风险评分
4. 新增规则提案层，不要直接修改 `rules.d`
5. 新增 proposal 审批与落盘
6. 审批通过后再调用 `validate` 和 `reload`
7. 新增 `verifyGuardEffect`
8. 新增 `rollbackGuardianRule`
9. 最后再考虑自动化封堵

## 11. Final assessment

你的计划方向是对的，而且很适合用 ReAct agent 做成闭环。

但如果要上生产，我的结论是：

- 可以做
- 不能一步到位全自动
- 必须先做成“观测 -> 审计 -> 提案 -> 审批 -> 执行 -> 复核 -> 回滚”的受控闭环

最容易出事的地方不是模型能力，而是：

- 证据不完整
- 规则冲突
- 自我封堵
- 并发 agent 重复下发
- 缺少回滚
- 误报导致业务中断

所以，生产环境里的优先级应该是：

1. 正确性
2. 可回滚
3. 可审计
4. 自动化
