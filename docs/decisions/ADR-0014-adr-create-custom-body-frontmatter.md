---
id: ADR-0014-adr-create-custom-body-frontmatter
type: decision-record
status: active
created: 2026-09-26
updated: 2026-09-26
author: dsh-context-milvus
supersedes: null
superseded_by: null
code_anchors:
  - file: packages/core/src/adr-service.ts
    symbols:
      - createAdr
      - withGeneratedFrontmatter
  - file: packages/core/test/adr-service.spec.ts
  - file: packages/dsh/src/plugins/dsh-context-milvus/adr-tools.ts
  - file: packages/codex/src/adr-handlers.ts
trigger:
  task_id: null
  requirement_summary: 'ADR-0011 因无 frontmatter 而对决策系统隐身；根因是 AdrService.createAdr() 用 params.content 整文件覆盖模板。需让 content 只作为正文、frontmatter 无条件由引擎生成，并补回 ADR-0011 的 frontmatter。'
  change_type: bugfix
related_decisions: [ADR-0011-tool-output-lossless-json-null-convention, ADR-0002-code-anchors-reverse-index]
auto_generated: false
---

# create_adr 的自定义正文必须保留引擎生成的 frontmatter

## 背景

`create_adr` 的 `content` 参数在两个适配器里的文案都是**正文**语义
（DSH `adr-tools.ts`：「自定义内容（留空则用模板自动生成）」；codex `schemas.ts`：
「自定义正文，留空则用模板生成」），而 `AdrService.createAdr()` 的实现是：

```ts
const content = params.content || DEFAULT_TEMPLATE.replace(...)
```

即 `params.content` 一旦非空就**整文件覆盖**模板——包括 frontmatter。

后果不是格式难看，而是**记录对决策系统隐身**：`parseFrontmatter()` 要求 `id`
存在，否则返回 `null`；`list_adrs` / `search_adr` / `search_adr_by_file` /
`load_constraints` 全部依赖它。于是这条决策既搜不到，也不会在修改相关文件时被注入
约束——正是决策记忆系统本应防住的失败。

### 实证受害者

`docs/decisions/ADR-0011-tool-output-lossless-json-null-convention.md`
（2026-09-18，commit `4549c74`）就是无 frontmatter 的：文件从 `## 背景` 直接开始，
因此长期不出现在 `list_adrs` 里。它记录的约束（工具边界返回值不得出现 `undefined`
属性、边界契约修复必须落在 core、`IndexStatus` 公共类型变更需对齐冻结契约测试）
在隐身期间无法被自动注入。本次修复一并补回了它的 frontmatter。

## 决策

**frontmatter 是无条件不变式：`createAdr` 永远由引擎生成它，`content` 只提供正文。**

```ts
const rendered = DEFAULT_TEMPLATE.replace(...)   // 先渲染模板（含 frontmatter）
const content = params.content
  ? withGeneratedFrontmatter(rendered, params.content)
  : rendered
```

`withGeneratedFrontmatter()` 的行为：

- 取渲染后模板的 frontmatter 块作为头部——复用同一份 `id` / `created` /
  `change_type` / `requirement_summary` / `supersedes` 渲染结果，不重复实现替换链
- 若调用方正文自身以 frontmatter 块开头，**剥掉它**，只保留其后的正文
- 否则正文原样保留

## 被否决的方案

- **原样保留调用方提供的 frontmatter**：`FRONTMATTER_PATTERN` 只认第一个块，
  记录 `id` 会与文件名不一致（实测：内容带 `id: ADR-0009-pre` 时，产出的文件名是
  `ADR-0001-pre.md`，`loadAdr('ADR-0001-pre')` 立刻失效）。
- **把 `content` 视为完整文件、无 frontmatter 就报错**：与两个适配器既有的参数文案
  冲突，会让当前所有 `create_adr(content=正文)` 调用直接失败。
- **只在适配器层补 frontmatter**：core 是 DSH 与 codex 的共享内核，两处各补一次必然
  漂移（与 ADR-0011 记录的「边界契约修复必须落在 core」同一条理由）。
- **静默容忍无 frontmatter 的文件**：等于接受「决策记录存在但对系统不可见」，
  这正是本次要修的失败模式本身。

## 隐性约束

- 无 `content` 时 `DEFAULT_TEMPLATE` 的输出必须逐字节不变（既有 `AdrService` 用例是验收线）。
- frontmatter 块形状必须与 `adr-frontmatter.ts` 的 `FRONTMATTER_PATTERN`
  （`/^---\n([\s\S]*?)\n---\n?/`）一致，含首个块与结尾换行。
- 自定义正文不得混入模板正文（不得出现 `### 方案A` 等占位小节）。
- 写入仍是 temp file + rename（ADR-0002 的原子写入约束；本改动未触碰该路径）。
- 已知残留：`updateAdr(..., { merge: true })` 仍假定文件已有 frontmatter
  （`content.indexOf('---', 3)`），对无 frontmatter 的文件会破坏正文。本 ADR 只修
  `createAdr` 这一**产出侧**；修复后不再有新产生的无 frontmatter 记录。

## 后果

- 所有 `create_adr` 产出（含自定义正文）都可被 `list_adrs` / `search_adr` /
  `search_adr_by_file` / `load_constraints` 解析。
- ADR-0011 恢复可见，其约束重新参与注入。
- 运行中的 DSH 插件仍走已加载的旧代码，需重建/重启后才对新调用生效。
