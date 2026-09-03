---
id: ADR-0004-import-resolver-cross-file-resolution
type: decision-record
status: active
created: 2026-09-02T23:31:21.317Z
updated: 2026-09-02T23:31:21.317Z
author: dsh-context-milvus
supersedes: null
superseded_by: null
code_anchors:
  - file: src/plugins/dsh-context-milvus/import-resolver.ts
    symbols:
      - ImportResolver
      - ImportEntry
      - ImportMap
      - ImportMapStats
      - extractImportFromNode
      - extractExportSymbols
      - resolveImportPathWithFallback
    lines: [1, 491]
    git_commit: 27d82ef
trigger:
  task_id: "4"
  requirement_summary: "Create ImportResolver class for cross-file import/export analysis using tree-sitter AST, as part of the V2 cross-file import resolution plan (Task 4)"
  change_type: new_feature
related_decisions: []
auto_generated: false
---

## 决策目标

新建 `ImportResolver` 类（`src/plugins/dsh-context-milvus/import-resolver.ts`），在索引期用 tree-sitter AST 扫描每个文件的 import/export 语句，构建并持久化跨文件双向 Import Map（imports + exports），为 find_callers / trace_call_chain 提供精确的跨文件引用匹配能力。这是 V2 跨文件导入解析计划（10 任务）的第 4 个任务。

## 约束条件

- 必须复用 `chunker.ts` 的语言配置（`getLanguageForExtension` / `getParser` / `hasTsParser`），不重复定义语言映射
- Import Map 以 JSON 文件持久化，支持增量加载（`load`）与批次保存（`save`）
- 只处理相对路径导入（`./foo`、`../foo`）与部分绝对路径；裸包导入（如 `lodash`）V2 阶段跳过
- 无 tree-sitter parser 的语言（如 PHP）跳过导入解析，不产生 import map 条目

## 候选方案与权衡

### 方案A：运行时按需解析（不做持久化 Import Map）
- **描述**：每次 find_callers 调用时实时解析文件 import
- **优点**：实现简单，无状态文件
- **缺点**：每次查询都要重新解析，性能差；无法跨进程复用
- **放弃原因**：查询延迟不可接受，且无法支撑 trace_call_chain 的多跳链路

### 方案B：索引期构建持久化双向 Import Map（✅ 选用）
- **描述**：索引代码时同步扫描 import/export，构建 `{imports: {file → {symbol → {target, exportedAs}}}, exports: {file → [symbol]}}` 并持久化为 JSON
- **优点**：查询 O(1)；增量索引天然维护；exports 反向索引可直接支撑 find_callers
- **缺点**：文件删除/移动时需要同步清理条目（`removeFile` 处理）
- **选择原因**：与现有 HashTracker 增量索引架构一致，构建成本摊薄在索引期

## 关键设计细节与隐性约束

### 隐性约束1：扫描前必须清除旧条目（removeFile first）
- **内容**：`scanFile` 必须先调用 `this.removeFile(filePath)` 再写入新条目，避免增量重扫后残留过期 import/export
- **原因**：文件内容变化会增删符号，原地更新会产生幽灵引用
- **如果破坏会怎样**：删除的导出仍会出现在 getExports 结果中，导致 find_callers 指向已不存在的符号

### 隐性约束2：解析失败必须静默跳过
- **内容**：`parser.parse` 及后续 AST 遍历包在 try/catch 中，失败仅跳过该文件
- **原因**：索引管道不应因单个文件语法错误中断整批索引
- **如果破坏会怎样**：任一坏文件会导致整个索引失败，违背增量索引容错设计

### 隐性约束3：导出符号去重
- **内容**：`extractExports` / `deriveExportsFromChunks` 去重后才写入 exports
- **原因**：同文件多次导出同一符号（如 re-export）不应产生重复条目
- **如果破坏会怎样**：getExports 返回重复符号，find_callers 结果出现重复匹配

## 被否决的模式/反模式

- ❌ 对无 tree-sitter 支持的语言（PHP）用正则猜测导入 —— 误报率高且无法解析字段，V2 直接跳过
- ❌ 在模块级维护全局单一 map 实例 —— 多工作区会互相污染；必须实例化并绑定独立 mapPath

## 相关测试

- `test/import-resolver.spec.ts`（Task 8 计划创建）：scanFile 提取 import/export、resolve/getExports/isImportedFrom、load/save 持久化、removeFile 清理、getStats

## 变更边界

- 新增多语言解析器（GO/Java 的包路径映射精度提升）时，重新评估 resolveImportPath 与 fallback 逻辑
- 需要支持裸包导入（node_modules）时，重新评估 resolveImportPathWithFallback 的路径策略