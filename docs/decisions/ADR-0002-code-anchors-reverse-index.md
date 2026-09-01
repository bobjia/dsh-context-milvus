---
id: ADR-0002-code-anchors-reverse-index
type: decision-record
status: active
created: 2026-09-01
updated: 2026-09-01
author: dsh-context-milvus
supersedes: null
superseded_by: null
code_anchors:
  - file: src/plugins/dsh-context-milvus/adr-anchor-index.ts
    symbols:
      - AdrAnchorIndex
      - getAdrsForFile
      - setAdr
      - removeAdr
      - save
      - load
    lines: [1, 115]
    git_commit: ''
  - file: src/plugins/dsh-context-milvus/adr-service.ts
    symbols:
      - getActiveConstraints
      - root
    lines: [77, 345]
    git_commit: ''
  - file: src/plugins/dsh-context-milvus/adr-tools.ts
    symbols:
      - search_adr_by_file
      - check_adr_consistency
      - serviceForExec
      - resolveEffectiveIndexRoot
      - resolveEffectiveAdrRoot
    lines: [40, 470]
    git_commit: ''
trigger:
  task_id: null
  requirement_summary: 需要 O(1) 的确定性文件→ADR 关联查找，不依赖语义搜索
  change_type: new_feature
related_decisions:
  - ADR-0001-milvus-collection-separation
auto_generated: false
---

## 决策目标

实现 `code_anchors` 反向索引，提供从代码文件路径到 ADR 的 O(1) 确定性查找，不依赖 Milvus 语义搜索。这是 ADR 决策记忆系统的核心基础设施之一。

## 约束条件

- 查找必须 O(1) 时间复杂度，不能因为 ADR 数量增加而变慢
- 必须持久化到磁盘，进程重启后可恢复
- 写入必须是原子操作，避免崩溃时数据损坏
- 路径必须标准化（解析符号链接、统一分隔符），避免 `/a/b/c` 和 `/a/b/c/` 被视为不同路径

## 候选方案与权衡

### 方案A：每次查询时扫描所有 ADR 文件（❌ 放弃）
- **描述**：每次需要查找文件关联的 ADR 时，遍历所有 ADR 文件，解析 frontmatter 的 code_anchors
- **优点**：无需额外存储，数据始终最新
- **缺点**：O(n) 时间复杂度，ADR 数量增加时性能线性下降；大量 I/O 操作
- **放弃原因**：无法满足 O(1) 要求，每次查询都扫描文件系统效率太低

### 方案B：JSON 侧边文件反向索引（✅ 选用）
- **描述**：维护一个 JSON 侧边文件，以标准化文件路径为 key，ADR ID 列表为 value，实现双向映射。写入使用 temp file + rename 保证原子性
- **优点**：O(1) 查找，JSON 格式人类可读，持久化到磁盘，原子写入防崩溃
- **缺点**：需要维护同步（ADR 变更时更新索引）
- **选择原因**：简单可靠，O(1) 性能，JSON 格式便于调试和手动维护

### 方案C：SQLite 数据库（❌ 放弃）
- **描述**：使用 SQLite 存储文件→ADR 映射关系
- **优点**：查询灵活，支持复杂关联查询
- **缺点**：引入新的依赖，对简单需求来说太重
- **放弃原因**：过度设计，JSON 侧边文件足够满足需求

## 关键设计细节与隐性约束

### 隐性约束1：原子写入（temp file + rename）
- **内容**：`save()` 方法先写入临时文件，再通过 `rename()` 重命名为目标文件。如果写入过程中崩溃，临时文件会残留但目标文件保持旧状态
- **原因**：防止写入过程中崩溃导致 JSON 文件损坏，使整个索引不可用
- **如果破坏会怎样**：崩溃后索引文件损坏，所有 ADR 关联丢失，需要全量重建

### 隐性约束2：路径标准化
- **内容**：所有文件路径在索引前必须通过 `path.resolve()` 标准化，key 必须精确匹配。`getAdrsForFile()` 的入参也必须标准化后再查找
- **原因**：路径比较不能有歧义，同一文件的不同表示形式（相对路径、含 `.` 或 `..` 的路径、末尾带 `/` 的路径）必须指向同一个 key
- **如果破坏会怎样**：`getAdrsForFile()` 返回假阴性（有 ADR 关联但找不到），导致模型在修改代码前无法获取到相关 ADR 约束

## 被否决的模式/反模式

- ❌ 每次查询扫描文件系统 —— O(n) 性能，大量 I/O
- ❌ SQLite 存储 —— 过度设计，引入不必要的依赖
- ❌ Redis 等外部缓存 —— 增加运维复杂度，不适合这一简单的键值需求

## 相关测试

- test/adr-anchor-index.spec.ts: 完整覆盖 CRUD、持久化、路径标准化、原子写入

## 变更边界

- 当 ADR 数量超过 10 万条时，JSON 侧边文件可能成为性能瓶颈，届时考虑迁移到 SQLite
- 如果需要关联查询（如"找出所有被 adr-0001 覆盖的文件"），当前设计不支持，需要扩展
- 2026-09-01: 修复依赖 adrService 的工具使用 DSH 进程 cwd 而非 session 工作区路径的问题。`serviceForExec` 和 `resolveEffectiveIndexRoot` 辅助函数在工具执行时从 `exec.agent.session.header.cwd` 解析 session 工作区，创建指向正确路径的临时 AdrService 实例