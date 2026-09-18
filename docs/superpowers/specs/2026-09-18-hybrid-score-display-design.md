---
title: hybrid-score-display
type: spec
created: 2026-09-18
status: draft
id: SPEC-2026-09-18-hybrid-score-display
related_decisions: []
---

# 混合检索下的分数显示修正

## 概要

`hybridMode` 默认开启时，Milvus 走 `RANKER_TYPE.RRF`，返回的 `score` 是 **RRF（Reciprocal Rank Fusion）融合分**——即 `Σ 1/(k + 名次)`，k=60。它是**名次的倒数编码，不是相似度**。但 `milvus-service.ts` 原样透传该值，适配器又把它渲染成 `相关度: 0.0164`，于是每一次搜索看起来都像"只有 1.6% 相关"。

后果是工具被误判为不可用：模型第一次调用后读到 0.0164，判断"库里没有相关内容"，退回 grep / 读文件，不再调用。

本次修正**只改显示**：让引擎把分数的语义随结果带出来，渲染层据此选择表达方式——相似度就显示数值，RRF 就显示名次。**检索与排序完全不变**。

## 背景与约束

### 实测证据

同一 query、同一数据集，只切 `hybridMode`（`rerankConfig.enabled=false`，只看 Milvus 原始分）：

| 查询 | `hybridMode=true` | `hybridMode=false` |
|---|---|---|
| `BM25 稀疏向量 混合检索 RRF 融合` | 0.0161 ~ **0.0323** | 0.5510 ~ **0.5761** |
| `Milvus 集合初始化 与 schema 定义` | 0.0161 ~ **0.0164** | 0.6426 ~ **0.7400** |

混合模式被压缩在 0.016~0.032，且与 `1/(60+名次)` 逐位吻合：

| 文档处境 | RRF 分 |
|---|---|
| 仅一个检索器命中且排第 1 | `1/61` = 0.0164 |
| 两个检索器都排第 1 | `2/61` = 0.0328 |

即该数值**不含相似度信息**，只复述了名次（而名次本来就由结果顺序表达）。

### 约束

- **不能靠启发式猜测**：不允许"分数小于 0.1 就当作 RRF"这类阈值判断——引擎明确知道自己走了哪条分支，应显式传递。
- **`scoreKind` 缺失时按 `similarity` 处理**：`SearchResult` 是既有公共类型，新增字段必须可选，且缺省行为要与今天一致，避免破坏既有调用方与测试。
- **core 边界**：`packages/core/src` 不得 import `@deepseek-ai/*`、`@modelcontextprotocol/*`、`zod`，不得调用 `console.log/warn/info`（`core-boundary.spec.ts` 强制）。
- **冻结面**：`packages/dsh/test/public-surface.spec.ts` 钉住 13 个工具名与 27 个 `Config` 键，**必须零改动通过**。给既有工具的输出 schema **新增**字段是允许的。

## 非目标

- **不改检索质量与排序**：本次不动 BM25、不动向量检索、不动 reranker 的排序逻辑。
- **不改 `hybridMode` 默认值**：混合检索的关键词精确匹配能力是有价值的，不能为了分数好看而默认关闭。
- **不引入二次查询**：不为了拿到余弦分而对 Milvus 再查一次（那是方案 B，成本与复杂度都更高，本次不做）。
- **不治"测试文件霸榜"**：`test/` 下的文件常含字面标识符，BM25 会强命中它们。那是独立的检索质量议题，本次不处理。
- **不改 `find_callers` / `trace_chain` 的 `score: 1`**：那两处注释已写明"not a similarity search — all results are exact matches"，语义本就清楚，不在本次范围。

## 设计

### 1. 结果携带分数语义（`packages/core/src/types.ts`）

```ts
/** 分数语义：similarity = 绝对相似度（余弦，0~1）；rrf = 融合排序分（仅表名次）。 */
export type ScoreKind = 'similarity' | 'rrf'

export interface SearchResult {
  // ...既有字段
  score: number
  /** 缺失时视为 'similarity'（向后兼容）。 */
  scoreKind?: ScoreKind
}

export interface AdrSearchResult {
  // ...既有字段
  score: number
  scoreKind?: ScoreKind
}
```

### 2. 引擎标注（`packages/core/src/milvus-service.ts`）

`search()` 的结果映射（约 333-342 行）与 `searchAdr()` 的结果映射（约 702 行）各加一个字段：

```ts
scoreKind: this.effectiveHybridMode ? 'rrf' : 'similarity',
```

**注意**：用 `effectiveHybridMode`（而非 `hybridMode`）——前者会在检测到遗留的纯向量集合后被降级为 `false`（`milvus-service.ts:164` 附近），此时返回的确实是余弦分。

`searchAdr()` 同样有 `hybridSearch` + RRF 分支（约 675 行），同样标注。

### 3. 渲染（4 处）

| 文件 | 位置 |
|---|---|
| `packages/dsh/src/plugins/dsh-context-milvus/tools.ts` | `formatSearchResults`（约 39 行） |
| `packages/dsh/src/plugins/dsh-context-milvus/adr-tools.ts` | `formatAdrSearchResults`（约 40 行） |
| `packages/codex/src/result-format.ts` | `formatSearchResults`（约 48 行） |
| `packages/codex/src/result-format.ts` | ADR 搜索格式化（约 109 行） |

规则（`kind = item.scoreKind ?? 'similarity'`）：

- **`similarity`** → 保持现状：`相关度: 0.7400`
- **`rrf`** → 不显示数值，改为名次：`排序: 1/5`（`1` = `i + 1`，`5` = 结果总数）

**为什么 RRF 下显示名次而不是"相对百分比"**：RRF 分常在 0.0161~0.0164 之间聚集（比值 1.00 / 1.00 / 0.98），归一化后几乎全是 100%，会以另一种方式误导（"每条都同样相关"）。名次是 RRF 唯一能诚实提供的信息。

在 RRF 模式下，输出开头**追加一行说明**（每个输出一次，非每条结果）：

```
（混合检索：结果按 RRF 融合排序，仅提供名次，不提供绝对相似度分值。）
```

### 4. 输出 schema

`search_code`（dsh `tools.ts`）与 `search_adr`（dsh `adr-tools.ts`）的 items 是 `additionalProperties: false`，需在 `properties` 中声明新字段：

```ts
scoreKind: { type: 'string' },
```

codex 侧若 `schemas.ts` 对结果形状有声明，同样补充。

## 错误处理

- `item.scoreKind` 为 `undefined` 或未知字符串 → 一律按 `similarity` 处理（显示数值），绝不抛错。
- `item.score` 为 `undefined` 或非数值 → 沿用现有行为（当前实现是 `item.score.toFixed(4)`，会在 `undefined` 上抛错）；本次**不新增**对 score 缺失的容错，避免扩大改动面。
- `value.length === 0` → 既有早退分支不变。

## 测试

### core

- `milvus-service`：`hybridMode: true` → 每条结果 `scoreKind === 'rrf'`；`hybridMode: false` → `'similarity'`。
- `searchAdr` 同上。
- 若存在"遗留集合降级"的用例，断言降级后标注为 `'similarity'`（走 `effectiveHybridMode`）。

### dsh

- `formatSearchResults` 在 `scoreKind: 'rrf'` 时输出 `排序: N/M` 且**不含** `相关度:`，并含那行说明。
- `formatSearchResults` 在 `scoreKind: 'similarity'` 或**缺失**时输出 `相关度: 0.7400`（缺失即向后兼容）。
- `search_adr` 同样两条。
- `public-surface.spec.ts` **零改动**通过。

### codex

- `formatSearchResults` 两条（rrf / similarity）同上。

## 验收标准

1. `hybridMode=true` 下调用 `search_code`，渲染文本**不出现** `相关度: 0.0xxx` 这类数值，改为 `排序: N/M` 与一行说明。
2. `hybridMode=false` 下调用 `search_code`，渲染文本仍为 `相关度: 0.xxxx`（余弦值，量级 0.5~0.8）。
3. `search_adr` 行为与 `search_code` 一致。
4. `SearchResult.scoreKind` 缺失时渲染结果与本次改动前**逐字节一致**（向后兼容）。
5. 检索结果集与顺序在改动前后**完全一致**（本次只改显示）。
6. `npm test` 全绿、`npm run typecheck` 与 `npm run build` exit 0；`public-surface.spec.ts` 零改动通过。
