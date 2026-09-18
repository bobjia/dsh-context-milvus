---
id: ADR-0009-rrf-score-display-semantics
type: decision-record
status: active
created: 2026-09-18
updated: 2026-09-18
author: dsh-context-milvus
supersedes: null
superseded_by: null
code_anchors:
  - file: packages/core/src/types.ts
    symbols:
      - ScoreKind
      - SearchResult
      - AdrSearchResult
  - file: packages/core/src/milvus-service.ts
    symbols:
      - search
      - searchAdr
  - file: packages/dsh/src/plugins/dsh-context-milvus/tools.ts
    symbols:
      - formatSearchResults
  - file: packages/dsh/src/plugins/dsh-context-milvus/adr-tools.ts
    symbols:
      - formatAdrSearchResults
  - file: packages/codex/src/result-format.ts
    symbols:
      - formatSearchResults
trigger:
  task_id: null
  requirement_summary: "`search_code` / `search_adr` 在默认混合检索（hybridMode=true）下把 Milvus 的 RRF 融合分（约 0.016）当作相关度渲染，模型读成「1.6% 匹配」而弃用该工具。需让显示与分数的真实语义一致。"
  change_type: bugfix
related_decisions: [ADR-0001-milvus-collection-separation, ADR-0005-tool-output-schema-validation-fixes]
auto_generated: false
---

# 混合检索下 RRF 分数的显示语义

## 背景

`hybridMode` 默认 `true`，`MilvusService.search()` / `searchAdr()` 走 `client.hybridSearch` + `RANKER_TYPE.RRF`，Milvus 返回的 `score` 是 RRF（Reciprocal Rank Fusion）融合分：`Σ 1/(k + 名次)`，`k = bm25RrfK = 60`。

`milvus-service.ts` 原样透传该值（`score: item.score`），四处格式化器又渲染为 `相关度: ${score.toFixed(4)}`，于是默认配置下每次搜索看起来都像"只有 1.6% 相关"。

### 实测证据（同一 query、同一数据集，仅切 hybridMode，rerank 关闭）

| 查询 | `hybridMode=true` | `hybridMode=false` |
|---|---|---|
| `BM25 稀疏向量 混合检索 RRF 融合` | 0.0161 ~ 0.0323 | 0.5510 ~ 0.5761 |
| `Milvus 集合初始化 与 schema 定义` | 0.0161 ~ 0.0164 | 0.6426 ~ 0.7400 |

与 `1/(60+名次)` 逐位吻合：仅一个检索器命中且排第 1 → `1/61 = 0.0164`；两个检索器都排第 1 → `2/61 = 0.0328`。

文档也在强化这一错误契约：`README.md` / `README.zh.md` 的 `search_code` 返回示例写的是 `"score": 0.92`，一个在默认配置下不可能出现的值。

## 决策

**让引擎把分数的语义随结果带出来，渲染层据此选择表达方式。**

1. `types.ts` 新增 `export type ScoreKind = 'similarity' | 'rrf'`，`SearchResult` 与 `AdrSearchResult` 各加**可选**字段 `scoreKind?: ScoreKind`。
2. `milvus-service.ts` 在两处结果映射中标注 `scoreKind: this.effectiveHybridMode ? 'rrf' : 'similarity'`。
3. 四处格式化器按 `item.scoreKind ?? 'similarity'` 渲染：
   - `similarity` → `相关度: 0.7400`（维持原样，余弦值本身可解释）
   - `rrf` → `排序: N/M`，并在输出开头追加一行说明：`（混合检索：结果按 RRF 融合排序，仅提供名次，不提供绝对相似度分值。）`
4. `search_code` / `search_adr` 的输出 schema 补声明 `scoreKind`（其 items 为 `additionalProperties: false`）。

**只改显示，检索与排序零变化。**

## 为什么用 `effectiveHybridMode` 而不是 `hybridMode`

服务器不支持 BM25 function 字段时会降级为纯向量检索并把两者都置为 `false`。用 `effectiveHybridMode` 表达的是"本次实际走了哪条分支"，语义更准，且与降级后的真实返回一致。

## 被否决的方案

- **归一化为相对百分比（top-1 = 1.00）**：实测 RRF 分在 0.0161/0.0164 之间聚集，比值 1.00 / 1.00 / 0.98，归一化后几乎全是 100%，会以"每条都同样相关"的方式再次误导。RRF 唯一能诚实提供的信息就是名次。
- **渲染层启发式判断（如"分数 < 0.1 即视为 RRF"）**：引擎明确知道自己走了哪条分支，让渲染层去猜是设计缺陷，且阈值脆弱。
- **默认关闭 `hybridMode`**：混合检索的 BM25 关键词精确匹配能力有实际价值，不能为了分数好看而牺牲检索质量。
- **二次查询取回余弦分用于展示**：需要额外一次 Milvus 往返或改 `hybridSearch` 的 `output_fields`，成本与复杂度都高于本次收益，留作后续独立评估。
- **移除 `score` 字段**：会破坏既有消费方（telemetry、codex `structuredContent`、eval harness），且余弦模式下该值仍有意义。

## 隐性约束

- `scoreKind` 必须**可选**，且缺省时按 `similarity` 处理——否则既有调用方与既有测试会静默改变行为。验收要求：`scoreKind` 缺失时渲染结果与改动前**逐字节一致**。
- `packages/core/src` 不得 import `@deepseek-ai/*`、`@modelcontextprotocol/*`、`zod`，不得调用 `console.log/warn/info`（`core-boundary.spec.ts` 强制）。
- `packages/dsh/test/public-surface.spec.ts` 钉住 13 个工具名与 27 个 `Config` 键，必须零改动通过；给既有工具的输出 schema **新增**字段是允许的。
- `find_callers` / `trace_chain` 的 `score: 1` 是"精确匹配"语义（源码注释已写明 not a similarity search），不属于本次范围，不标注。

## 后果

- 默认配置下模型不再看到 0.0xxx 的伪相关度，改为明确的名次，消除"工具不可用"的误判。
- 余弦模式（`hybridMode: false`）行为完全不变。
- **未解决**：`test/` 下的文件常含字面标识符（如 `BM25_RRF_K`），BM25 会强命中，导致测试文件霸榜、挤掉真正实现。这是独立的检索质量议题，需另行处理。
- **未验证**："模型只用一次"确实由此分数导致，属于高置信度推断。仓库 `telemetryEnabled` 默认 `false`，无真实使用记录可佐证；如需确认应开启遥测后回看 `~/.milvus-index/telemetry.jsonl`。
