---
id: ADR-0013-relative-path-anchoring-before-filter
type: decision-record
status: active
created: 2026-09-26
updated: 2026-09-26
author: dsh-context-milvus
supersedes: null
superseded_by: null
code_anchors:
  - file: packages/dsh/src/plugins/dsh-context-milvus/workspace-root.ts
    symbols:
      - resolveWorkspaceRoot
  - file: packages/codex/src/workspace-resolver.ts
    symbols:
      - resolveWorkspaceRoot
  - file: packages/core/src/path-normalize.ts
    symbols:
      - buildFilePathLike
trigger:
  task_id: null
  requirement_summary: '2026-09-25 遥测显示 search_code 传入相对 path 时 resultCount=0；根因是 resolveWorkspaceRoot 未绝对化显式 path，而 Milvus 存储的 file_path 恒为绝对路径，前缀过滤恒不命中，表现为正常零结果而非报错。'
  change_type: bugfix
related_decisions: [ADR-0009-rrf-score-display-semantics, ADR-0012-telemetry-score-semantics-fields]
auto_generated: false
---

# 显式 path 必须先绝对化再作为 file_path 前缀

## 背景

`search_code` / `index_code` / `index_status` 与 ADR 工具都通过 `resolveWorkspaceRoot()`
解析工作区根，返回值随后在 `MilvusService.search()` 里经 `buildFilePathLike()`
变成 `file_path like "<root>%"` 过滤条件。

`resolveWorkspaceRoot()` 原先对显式 `path` 直接 `return explicitPath`，不做绝对化。
而 Milvus 中存储的 `file_path` 恒为绝对路径，于是传入相对路径时过滤条件恒不命中：
**表现为「未找到匹配的代码片段」这种正常零结果，而不是错误**，调用方无从察觉路径写错。

2026-09-25 遥测实证：`path = "ui/src/components/ChatArea"` → `resultCount: 0`、
`rerankEnabled: false`，是 17 次检索中**唯一**的零结果（1/17 = 5.9%）——不是「没搜到」，
是「过滤条件写错了」。

codex 适配器的 `workspace-resolver.ts` 一直是 `path.resolve(cwd, explicitPath)`
并额外校验路径存在且为目录，两个适配器在此处行为不一致。

## 决策

显式 `path` 为相对路径时，先锚定到 fallback 链算出的基准根再返回：

```ts
const base = sessionCwd || config.indexRoot || startupCwd || process.cwd()
return path.isAbsolute(explicitPath) ? explicitPath : path.resolve(base, explicitPath)
```

绝对路径原样返回（含 Windows 盘符路径）。基准根取 fallback 链的下一级，
语义是「相对路径相对于当前项目」。

## 被否决的方案

- **相对路径直接报错**：`path` 是模型生成的自由参数，报错会让一次本可成功的检索整轮失败；
  静默零结果的代价只是「白搜一次」，两者不成比例。
- **保留原样、只在结果里附警告**：调用方拿不到真实数据，仍要重试一次；且 `render` 层的
  警告无法修正 `index_code` / `index_status` 的同类参数。
- **在 `MilvusService.search()` 里兜底**：引擎层只有可能已经是相对串的前缀，
  拿不到「当前工作区根」的完整语义，在那里猜基准根会把职责放错层。

## 隐性约束

- fallback 优先级（explicit > session cwd > config.indexRoot > startupCwd > process.cwd()）
  对**绝对**路径的既有行为必须逐字不变；`workspace-root.spec.ts` 的既有 7 个用例是验收线。
- 绝对化只解决「相对 vs 绝对」，**不校验路径存在性**：路径写错或目录未索引仍返回零结果
  （与 codex 适配器抛 `E_WORKSPACE_NOT_FOUND` 不同，DSH 侧刻意保持不抛错）。
- `process.cwd()` 仍是最终兜底，不得因为引入 `base` 而改变「上游全空」时的取值。

## 后果

- 模型传相对子目录（如 `android/app/src/main`）不再恒返回零结果。
- 两个适配器的 workspace 解析语义对齐（差异仅在存在性校验，属已知边界）。
- 「零结果」恢复其可信含义：确实没搜到，而不是过滤条件写错。
