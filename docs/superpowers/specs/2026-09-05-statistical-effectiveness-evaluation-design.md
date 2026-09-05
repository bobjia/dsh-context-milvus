---
title: statistical-effectiveness-evaluation
type: spec
created: 2026-09-05
status: draft
id: SPEC-2026-09-05-statistical-effectiveness-evaluation
related_decisions: []
---

# 插件实际效果统计证明（Statistical Effectiveness Evaluation）

## 概要

为 `dsh-context-milvus` 建立一套可复现的统计评测体系，用**证据而非断言**证明插件的实际效果，用于推广/README 展示。

核心策略：**三层证据体系**——「离线检索质量」（可控实验）+「端到端 Agent 效率」（可控实验）+「实际运行观测」（观测性相关），贯穿使用非参数 + Bootstrap：

> **检索准（离线可证）→ 效率高（端到端可证）→ 任务成功（pass@k 可证）**
> 
> 第三层「实际运行观测」用真实使用数据**三角验证**前两层结论，仅作「相关/趋势」声明，不作因果断言。

## 目标与非目标

### 目标
- 证明语义检索（插件）相对 grep 与朴素向量 RAG 的检索质量提升，给出显著性 + 效应量 + 置信区间。
- 证明端到端 Agent 在插件辅助下 token 消耗、工具调用数、任务成功率的改善。
- 产出一套可复跑的评测脚本，随代码库维护，可反复验证。

### 非目标
- 不做学术级预注册 RCT（overkill，见方案 C）。
- 不替代模型上下文窗口（插件只筛选高质量上下文，见 README「不适用范围」）。
- 不做闭源/付费 embedding 服务的横评。
- 不评测 ADR 决策记忆系统的效果（价值命题与指标不同，无统一基线，另开独立 spec）。

## 三组基线定义

唯一变量是「检索引擎」，其余全部对齐。

| 组 | 检索策略 | 分块 | 排序 | 增量/关系分析 |
|---|---|---|---|---|
| **G（grep）** | 字符串/正则（原生 DSH 默认） | — | 关键字命中 | 无 |
| **R（naive RAG）** | 纯向量 cosine | 固定滑窗（256 token） | 相似度 | 无 |
| **P（插件）** | 向量 + BM25 | tree-sitter AST 边界 | RRF 融合 | 有（merkle/references/import map） |

**隔离约束**：
- 三组共用同一个 embedding 模型（如 `nomic-embed-text` / `bge-m3`）与同一个 Milvus 实例。
- R 组 = 关掉 AST 分块、BM25、RRF、增量、references/import map 的朴素实现。
- 由此可作减法归因：`P − R` = 插件工程能力；`P − G` = 语义检索增益。

## 评测层一：检索质量（离线，可复现）

### 数据构造
- 选取 1–2 个真实大仓库（>1000 文件，跨 TS/Python/Go）。
- 人工构造 50–100 条自然语言查询，每条标注 ground-truth 相关文件/函数集合（relevance judgments）。
- 标注者盲法：标注时不知道检索结果来源，避免确认偏误。

### 指标
- `recall@10`：ground-truth 相关项在 top-10 中的召回比例。
- `MRR`：首个相关项的排位倒数均值。
- `nDCG@10`：考虑排位的累积增益。
- `hit@1`：首位命中率。
- `precision@10`：top-10 中相关项占比。
- 另设 `path` 过滤子评测。

### 统计方法
- 同一查询在三组上配对计算指标。
- **配对 Wilcoxon signed-rank**（P vs G、P vs R）。
- **Bootstrap 1000 次 95% CI** 报告均值差。
- 效应量 **Cliff's Δ**（rank-biserial 相关系数）。

## 评测层二：端到端 Agent 评测

### 任务集
- SWE-bench 风格：从真实开源仓库取 30–60 个已修复 issue，有 gold patch + 可自动判定测试通过。

### 运行协议
- 同 LLM、同温度、同 system prompt、同任务、随机顺序。
- 每组每任务跑 **k=3 次**取中位数，消解 LLM 非确定性。

### 指标
- **主指标**：`pass@k`（测试通过率）。
- **效率指标**：`token/任务`、`工具调用数/任务`、`耗时/任务`。

### 统计方法
- 三组重复测量 → **Friedman 检验**（主效应）。
- 显著后 **Nemenyi 事后检验**（P vs G、P vs R）。
- 连续指标：配对 Wilcoxon + Bootstrap CI + Cliff's Δ。
- 成功率配对比例：**McNemar 检验**。
- 三次主对比做 **Holm 多重比较校正**。

## 评测层三：实际运行观测（观测性/相关）

> 定位：**三角验证（triangulation）**，用真实使用数据印证前两层结论，但**不替代**可控实验——观测性数据混杂因素无法控制，只能作「相关/趋势」声明。

### 数据源（分两档可行性）

**插件原生指标（当前即可落地）**：在工具 `execute` 内埋点，落本地 JSONL（默认关闭，opt-in）：
- `search_code`：query、topK、path、结果数、top score、检索耗时
- `index_code`：files/chunks indexed、duration、增量命中情况
- `index_status`：totalFiles / totalChunks / lastIndexed

**宿主级指标（需 DSH 暴露）**：session 级 token 消耗、工具调用总数、任务完成度。插件工具当前仅能访问 `exec.agent.session.header.cwd`，**token/工具调用计数不在插件可见范围内**，需依赖 DSH 宿主遥测或日志解析（待确认假设）。

### 统计方法
- 描述性聚合：median / IQR / 百分位 + Bootstrap 95% CI。
- 相关性：索引使用情况（如 `search_code` 命中次数）与结果质量信号的相关性。
- 若有时间序列：**interrupted time series / 分段回归** 做前后对比。
- 明确标注「观测性，仅相关，不声称因果」。

### 隐私约定
- 默认关闭、仅本地落盘、不采集源代码内容（只记 query 文本与统计量，query 可脱敏）。

## 样本量与效力（诚实性）

- 设定粗略功效目标（如检测 20% token 降幅，α=0.05，power=0.8，反推所需任务数 N）。
- **若实际样本不足则如实标注**：只报 CI 与效应量，不以 p 值硬撑显著性。

## 呈现话术模板（README/推广）

- 检索：「相对 grep，nDCG@10 平均 **+X%**（95% CI: [+a, +b]，p<0.01）」
- 效率：「相对 naive RAG，任务 pass@1 **+Ypp**，平均省 **Z% token**（Cliff's Δ = w，属大效应）」
- 图表：三组误差棒对比图、配对增益瀑布图、token/工具调用箱线图。

## 交付物

1. 本设计文档（`docs/superpowers/specs/`）。
2. 可复跑评测脚本（落点为 `scripts/eval/`），随代码库维护。
3. 插件原生埋点（opt-in，本地 JSONL 指标文件），供第三层观测统计。
4. 一份评测结果报告（README/推广素材，含上述图表与话术）。

## 复现性约定

- 固定随机种子（任务抽样、运行顺序、Bootstrap）。
- 记录 embedding 模型、LLM 版本、Milvus 版本、依赖版本号。
- 评测脚本以 `scripts/eval/` 独立目录组织，与业务代码解耦。
- 埋点默认关闭，仅本地落盘，不采集源代码内容。