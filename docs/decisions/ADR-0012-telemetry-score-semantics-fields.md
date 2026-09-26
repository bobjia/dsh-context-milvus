---
id: ADR-0012-telemetry-score-semantics-fields
type: decision-record
status: active
created: 2026-09-26
updated: 2026-09-26
author: dsh-context-milvus
supersedes: null
superseded_by: null
code_anchors:
  - file: packages/dsh/src/plugins/dsh-context-milvus/tools.ts
    symbols:
      - registerTools
  - file: packages/core/src/telemetry.ts
    symbols:
      - createTelemetry
  - file: scripts/eval/telemetry/run.mjs
  - file: scripts/eval/telemetry/lib/analyze.mjs
    symbols:
      - formatNumber
      - scoreSemantics
trigger:
  task_id: null
  requirement_summary: '2026-09-25 真实遥测显示 search_code 只记 topScore 不记分数语义，无法区分 RRF 名次编码与余弦相似度；k 在分数上不可辨识使 RRF 分不可反解；eval harness 又用 toFixed(1) 把 topScore 的中位数/IQR/均值抹成 0.0。'
  change_type: bugfix
related_decisions: [ADR-0009-rrf-score-display-semantics]
auto_generated: false
---

# 遥测必须记录分数语义（scoreKind / bm25RrfK）

## 背景

`search_code` 的遥测条目只记录 `topScore`，不记录分数语义。而在默认 `hybridMode: true` 下，
`MilvusService.search()` 返回的是 RRF 融合分 `Σ 1/(k + 名次)`（`k = bm25RrfK = 60`），
余弦模式下才是相似度——**同一个 `topScore` 字段承载两种量纲完全不同的值**。

ADR-0009 修掉了模型侧的误读（渲染为 `排序: N/M`），但把 telemetry 列为既有消费方后，
只做了「不移除 score」的保守决策，遥测层是否要带语义当时未处理。

2026-09-25 的真实遥测（`~/.milvus-index/telemetry.jsonl`）暴露了这个缺口：

- `topScore` 全部落在 0.0271–0.0328，**无法从数据本身判断**这是 RRF 还是余弦
- 按 `k = 60` 反解 `1/(60+a) + 1/(60+b)`：17 条中 16 条带分数的记录**全部命中**（14 条唯一解），
  反解出最终 top-1 在至少一个检索分支的真实名次**中位数 = 2、13/16 ≤ 3**
  → 检索质量其实不差，是「0.03 看起来像失败」误导了分析
- `k` 在分数上**不可辨识**：`k = 10` 同样能解释全部 16 条 → 不给 k 就无法反解名次

同时 `scripts/eval/telemetry/run.mjs` 对所有数值字段统一 `toFixed(1)`，把 `topScore` 的
中位数 / IQR / 均值渲染成 `0.0`，唯一能反映命中深浅的字段被抹平。

## 决策

1. `search_code` 遥测条目**新增两个字段**，不动任何既有字段名：
   - `scoreKind: results[0].scoreKind ?? 'similarity'`，无结果时为 `null`
   - `bm25RrfK: resolveConfig().bm25RrfK`
2. 分析脚本按量级自适应格式化：`formatNumber()` —— `|v| >= 1` 维持 1 位小数，
   `|v| < 1` 改用 5 位有效数字，`0` 输出 `0`。
3. 报告新增「分数语义」小节，统计 `rrf` / `similarity` / **未标注** 三类，
   并对未标注条目显式告警（历史条目没有该字段，不得默认为 RRF）。

## 为什么新增字段而不是改名义或换算

- **不重命名 `topScore`**：ADR-0009 已判定 `score` 字段有多个既有消费方（telemetry、
  codex `structuredContent`、eval harness），重命名是破坏性变更；新增字段才是增量兼容。
- **不把 RRF 分换算成相似度再记**：两者量纲不可互转，换算只会制造新的伪精确。
- **不靠阈值猜测语义**：与 ADR-0009 拒绝「渲染层启发式判断」同理，引擎明确知道自己走了哪条分支。
- **`bm25RrfK` 必须一起记**：`k` 不可辨识，缺 k 的 RRF 分无法反解出名次。

## 隐性约束

- `scoreKind` 缺失时按 `similarity` 处理，与 ADR-0009 渲染层的缺省保持一致。
- 遥测是 opt-in，只记查询文本与统计量、不记源码内容，文件以 0600 权限写入（`telemetry.ts` 既有契约）。
- `packages/dsh/test/public-surface.spec.ts` 钉住 13 个工具名与 27 个 `Config` 键：新增遥测字段不涉及。
- `bm25RrfK` 必须从 `resolveConfig()` 实时取，不得缓存——GUI 改配置后要立即生效。

## 后果

- 事后可反解：由 `topScore` + `bm25RrfK` 还原最终 top-1 在两个检索分支的真实名次。
- 报告不再把 RRF 分量级抹成 `0.0`；`toFixed(1)` 归零这一回归点由
  `scripts/eval/telemetry/lib/analyze.test.mjs` 双侧钉住（`0.031514` 保持两位可辨、`47` → `47.0`）。
- 迁移期新旧条目混存：旧条目「未标注」，报告会持续告警直到数据滚动掉。
