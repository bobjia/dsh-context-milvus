---
id: ADR-0001-milvus-collection-separation
type: decision-record
status: active
created: 2026-09-01
updated: 2026-09-01
author: dsh-context-milvus
supersedes: null
superseded_by: null
code_anchors:
  - file: src/plugins/dsh-context-milvus/milvus-service.ts
    symbols:
      - ensureAdrCollection
      - insertAdrChunks
      - searchAdr
      - deleteAdrByFilePath
    lines: [1, 2600]
    git_commit: ''
  - file: src/plugins/dsh-context-milvus/config.ts
    symbols:
      - adrCollection
    lines: [52, 52]
    git_commit: ''
  - file: src/plugins/dsh-context-milvus/types.ts
    symbols:
      - AdrSearchResult
    lines: [60, 85]
    git_commit: ''
trigger:
  task_id: null
  requirement_summary: ADR 决策记忆系统需要与代码索引分离的专用 Milvus 集合，以支持独立搜索
  change_type: new_feature
related_decisions: []
auto_generated: false
---

## 决策目标

为 ADR 决策记忆系统设计独立的 Milvus 集合，与代码索引的 `code_embeddings` 集合分离，使 ADR 决策记录能够独立于代码进行语义搜索、过滤和生命周期管理。

## 约束条件

- ADR 集合必须与 `code_embeddings` 共享同一个 Milvus 实例（不引入新的基础设施）
- 必须支持 BM25 + 向量混合搜索（与代码搜索一致的混合搜索策略）
- 集合 schema 必须包含 ADR 特有的字段（adr_id、status、section、code_anchors）
- 必须支持 graceful degradation：当 Milvus 服务端不支持 BM25 function 时不阻塞索引

## 候选方案与权衡

### 方案A：单一集合，用 type 字段区分（❌ 放弃）
- **描述**：在现有 `code_embeddings` 集合中增加 `type` 字段，通过字段值区分代码块和 ADR 段落
- **优点**：无需创建新集合，管理简单
- **缺点**：schema 难以统一（代码字段和 ADR 字段差异大）；查询时需要额外过滤；未来 schema 演进会互相影响
- **放弃原因**：耦合度过高，ADR 特有的过滤需求（status、section）无法在不影响代码搜索的情况下扩展

### 方案B：独立集合 `adr_embeddings`（✅ 选用）
- **描述**：创建独立的 `adr_embeddings` 集合，schema 专为 ADR 设计，保留 `id` + `vector` + `content` 基础字段，添加 `adr_id`、`status`、`section`、`code_anchors`、`file_path`、`trigger_type` 等 ADR 特有字段
- **优点**：schema 解耦，独立的过滤和搜索策略，可独立删除/重建
- **缺点**：多一个集合需要管理，BM25 初始化需要额外配置
- **选择原因**：架构清晰，ADR 和代码的搜索模式差异大，独立集合是最优解

## 关键设计细节与隐性约束

### 隐性约束1：BM25 必须 graceful degradation
- **内容**：`ensureAdrCollection` 方法在创建集合时尝试配置 BM25 函数字段，如果服务端不支持，必须捕获异常并回退到纯向量搜索
- **原因**：不同的 Milvus 版本对 BM25 的支持不同，生产环境和开发环境可能版本不一致
- **如果破坏会怎样**：ADR 索引在旧版 Milvus 上完全不可用

### 隐性约束2：`searchAdr` 的 `codeAnchors` 字段必须从 JSON 字符串解析
- **内容**：Milvus 存储 `codeAnchors` 为 JSON 字符串，`searchAdr` 返回前需要解析回对象数组
- **原因**：Milvus 不支持嵌套数组类型，JSON 字符串是最直接的序列化方案
- **如果破坏会怎样**：搜索结果的 `codeAnchors` 字段为空，模型无法看到代码锚点信息

## 被否决的模式/反模式

- ❌ 在现有集合中加字段共用 —— 耦合度高，schema 难以统一，过滤效率低

## 相关测试

- test/dsh-context-remdb.spec.ts: ensureAdrCollection 创建逻辑、BM25 fallback
- test/adr-service.spec.ts: AdrSearchResult 字段解析

## 变更边界

- 需要额外的 Milvus 集合时，按照 `ensureAdrCollection` 模式扩展
- 当 Milvus SDK 的 BM25 API 变更时，需要更新 fallback 逻辑