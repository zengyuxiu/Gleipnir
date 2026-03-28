# Documentation Index

这份索引用来区分“当前实现文档”和“背景参考文档”，方便继续开发时快速定位信息。

## 建议优先阅读

### 1. 项目现状与开发入口

- [../README.md](../README.md)
  - 英文主 README，包含仓库概览、当前能力、运行方式和下一步开发建议
- [../README.zh-CN.md](../README.zh-CN.md)
  - 中文辅助 README，便于中文语境下快速浏览当前能力边界

### 2. Agent 架构

- [react-agent-architecture.md](./react-agent-architecture.md)
  - 当前 agent 运行方式
  - `general` / `packet-analysis` 两种 profile 的职责边界
  - 新增 agent / tool 时的设计约束

### 3. Tool 与控制面契约

- [tool-api.md](./tool-api.md)
  - AgentGuardian 当前能力总结
  - `status / validate / reload` 的 HTTP/JSON 契约
  - 适合上层 tool 封装与平台接入

### 4. 日志证据检索

- [log-rag.md](./log-rag.md)
  - Log RAG 的数据流、schema、CLI、HTTP API、agent 集成方式

### 5. 安全控制闭环

- [security-audit-control-loop.md](./security-audit-control-loop.md)
  - 当前能力与目标架构差距
  - 生产化控制闭环建议
  - 分阶段上线方案

## 专题参考

- [sse-processor.md](./sse-processor.md)
  - SSE 归并逻辑背景说明
  - 有助于理解为什么流式事件最终要整理为可审计证据

## 历史/背景文档

- [agent-tool-development.md](./agent-tool-development.md)
  - 更偏早期 AgentSight agent tool 模板和背景知识
  - 对理解 AgentSight 所在生态有帮助，但不是当前仓库的最准实现说明

## 继续开发时的推荐顺序

1. 先读 [../README.md](../README.md)，确认当前已实现边界。
2. 再读 [react-agent-architecture.md](./react-agent-architecture.md) 和 [tool-api.md](./tool-api.md)，确定 agent/tool 层怎么扩展。
3. 如果要做日志检索或证据回放，继续看 [log-rag.md](./log-rag.md)。
4. 如果要推进自动化安全闭环，再看 [security-audit-control-loop.md](./security-audit-control-loop.md)。
