# Codex ADR 决策记忆移植 — 验收记录

> 执行日期：2026-09-12
> 对应规格：`docs/superpowers/specs/2026-09-12-codex-adr-port-design.md`
> 对应计划：`docs/superpowers/plans/2026-09-12-codex-adr-port.md`
> 执行分支：`feat/codex-adr-port`
> 结论：**Task 1–9 全部完成，自动化验收 9 条全过；真实 Milvus 下的 ADR 索引往返与 Codex CLI 端到端本环境不具备，列为待人工执行（下方给出逐条命令与判据）。**

---

## 1. 自动化验收（已执行）

环境：Node v22.23.2 / npm 10.9.8，Linux，`127.0.0.1:19530` 未开放（无 Milvus），未登录 Codex CLI。

基线 `23 suites / 286 tests` → 终态 **`29 suites / 363 tests`**，逐任务递增可追溯：

| Task | suites | tests | 说明 |
|---|---|---|---|
| 起点 | 23 | 286 | `main` @ `76a7a8a` |
| 1 引擎迁 core | 23 | 286 | **数字不变即"纯搬迁"的证据** |
| 2 路径助手 | 24 | 297 | +11 等式测试 |
| 3 `ADR_*` env | 25 | 310 | +13 |
| 4 `createAdrBundle` | 26 | 316 | +5 bundle +1 `createWhenMissing` |
| 5 DSH 切 bundle | 26 | 316 | **不变即 DSH 零行为变化的证据** |
| 6 4 个只读工具 | 27 | 328 | +11 handler +1 冒烟分支 |
| 7 4 个写类工具 | 28 | 357 | +13 门控 +12 handler +4 core |
| 8 被动提醒 | 29 | 363 | +6 |

对照规格 §9 的九条验收：

| # | 验收条 | 证据 | 实测 |
|---|---|---|---|
| 1 | 全量测试绿且 > 286 | `npm test` | 29 suites / **363** tests PASS |
| 2 | 构建与类型 | `npm run build && npm run typecheck` | 三包 tsc 退出码均 0 |
| 3 | 关→5 工具，开→13 工具 | `packages/codex/test/mcp-smoke.spec.ts` | 真实子进程两分支各自"有且仅有"通过 |
| 4 | 四个写工具默认拒写且磁盘零变化 | `adr-write-gate.spec.ts` + 下方 stdio 实跑 | `E_ADR_WRITE_DISABLED`，`diff` 无差异 |
| 5 | 未启用时 `search_code` 输出逐字节不变 | `search-code-adr-hint.spec.ts` | `appendAdrHints(...) === formatSearchResults(...)` |
| 6 | core 边界仍绿 | `core-boundary.spec.ts`（未修改） | 迁入的 6 个 ADR 模块同样合规 |
| 7 | `public-surface.spec.ts` 未改即通过 | `git diff --stat` 为空 + 该 spec PASS | 13 工具名 + 27 Config 字段全匹配 |
| 8 | ADR 装配不污染 stdout | `node packages/codex/bin/cli.js doctor` | `ADR_ENABLED` 开/关两种模式下 **stdout 均 0 字节**，诊断 453 字节全在 stderr |
| 9 | 两端共用同一份 ADR 状态文件 | `adr-path-derivation.spec.ts` + `adr-bundle.ts` | 新助手与历史 `.replace('merkle', ...)` 公式在 4 类路径（含空格、中文）下逐字符相等 |

### 写门控的 stdio 端到端实跑（三条互证）

对临时仓库直接喂 JSON-RPC，验证门控不仅单测成立，且**发生在任何磁盘与网络操作之前**：

| 场景 | 期望 | 实测 |
|---|---|---|
| `ADR_ENABLED=true`，写开关不设，`create_adr` | 拒写，错误码点名开关 | `错误 [E_ADR_WRITE_DISABLED]: ... 设环境变量 CONTEXT_MILVUS_ADR_WRITE=true 并重启 Codex`；`find` 前后差集为空 |
| 同上但 `CONTEXT_MILVUS_ADR_WRITE=true`（正对照） | 跨过写门控 | `错误 [E_MILVUS_UNREACHABLE]: 14 UNAVAILABLE ... ECONNREFUSED 127.0.0.1:19530`，且 `ADR-0002-allowed-now.md` 确实写出 —— 证明开关不是反向的 |
| `ADR_ENABLED=true` + 写开关开，但目标仓库无 `docs/decisions` | 拒绝且**不代建目录** | `错误 [E_ADR_NOT_INITIALIZED]: ... 检查 ADR_ROOT（默认 docs/decisions）`；目录保持为空 |

第一条的错误码是关键：若门控在索引之后，无 Milvus 时应先报 `E_MILVUS_UNREACHABLE`。

版本号：`dsh-context-milvus-core@0.2.0`、`dsh-context-milvus@0.6.7`、`codex-context-milvus@0.2.0`（两个适配器依赖 `^0.2.0`；`.codex-plugin/plugin.json` 同步 0.2.0）。

---

## 2. 待人工执行 A：真实 Milvus 下的 ADR 往返

前置条件：Milvus 可用（`docker run -d --name milvus -p 19530:19530 milvusdb/milvus:latest standalone`）+ OpenAI 兼容 embedding 端点。

```bash
cd <一个有 docs/decisions/*.md 的仓库>
export ADR_ENABLED=true MILVUS_ADDRESS=localhost:19530 \
       EMBEDDING_ENDPOINT=... EMBEDDING_MODEL=... MILVUS_EMBEDDING_DIM=768
node <repo>/packages/codex/bin/mcp.js   # 或直接经 Codex 调用
```

判据：

1. `list_adrs` 返回该目录下的 ADR，`status` 过滤生效。
2. `search_adr query="<ADR 正文里的说法>"` 命中对应 `adrId`，`adr_embeddings` 集合被自动创建。
3. `search_adr_by_file filePath=<被 code_anchors 覆盖的文件>` 返回非空。
4. `index_specs dryRun=true` 只预览；改 `dryRun=false` 后 `filesIndexed > 0`（需 `CONTEXT_MILVUS_ADR_WRITE=true`）。
5. `check_adr_consistency` 对一个已删除的文件报失效锚点；`fix=true` 后该锚点从 frontmatter 消失，且**不残留 `.tmp` 文件**。
6. `search_code` 命中被 ADR 覆盖的文件时，文本末尾恰好一行 `相关决策: <adrId> <标题> (<status>)`。
7. **跨适配器共享**：在 DSH 里 `create_adr`，在 Codex 里 `list_adrs` 能立刻看到同一条（验证 §9 第 9 条在真实数据上成立，而非仅路径等式）。
8. ADR 索引期间 MCP 的 stdout 仍只有 JSON-RPC（把 stdout 重定向到文件，逐行 `jq -e .jsonrpc` 应全部通过）。

## 3. 待人工执行 B：Codex CLI 端到端

`codex mcp add context-milvus -- npx -y codex-context-milvus mcp`（或在 `.codex/config.toml` 的 `[mcp_servers.context-milvus.env]` 里写 `ADR_ENABLED = "true"`）。判据：`/tools` 里出现 13 个工具；`AGENTS.md` 指向 `packages/codex/skills/context-milvus/SKILL.md` 的 ADR 规则后，agent 在改被覆盖文件前会先 `search_adr_by_file`。

---

## 4. 已知限制（设计如此，非缺陷）

- **无约束注入。** Codex 没有可向对话写入的钩子，提醒只是 `search_code` 末尾一行 `相关决策:`；未覆盖时输出与不含 ADR 的版本逐字节相同。
- **工具表在启动时定死。** MCP 无法中途扩表，故 `ADR_ENABLED` 改动必须重启 Codex；这也是 ADR 工具"要么 5 个要么 13 个"的原因。
- **写开关按实际写意图判定。** `index_specs`（`dryRun` 缺省即 true）与 `check_adr_consistency`（`fix=false`）默认可用；只有真正落盘才要求 `CONTEXT_MILVUS_ADR_WRITE=true`。
- **`create_adr` 写文件成功后若索引失败，文件保留。** 与 DSH 端 `createAdr → 再索引` 的既有语义一致，不做回滚。
- **MCP 端永不建 ADR 目录。** 目录缺失一律 `E_ADR_NOT_INITIALIZED`；DSH 保留历史上"加载即建目录"的行为（显式 `createWhenMissing: true`）。

---

## 5. 执行期间的计划偏差（供复核）

1. **`constraint-injector.spec.ts` 需要补 Milvus SDK 桩**（计划未预案）。它留在 dsh，但迁移后 `constraint-injector.ts` 改从 core 包名取 `AdrService`，import 链因此撞上 core barrel → 真 SDK → Jest ESM 崩。按仓库既有约定加 `jest.unstable_mockModule` 桩解决。
2. **批量改 import 的正则误伤**：`./adr-*.js → 包名` 把 `./adr-tools.js` 也卷了进去，而 `adr-tools.ts` 是**留在 dsh** 的，`registerAdrTools` 的导入已改回本地路径（构建报错暴露了它，不是靠猜）。
3. **`AdrService` 构造函数无条件 `mkdirSync`**，且 `createAdr` 依赖目录已存在（只做 tmp+rename），导致规格 §5.5"不擅自建目录"在现状下无法兑现。经人工确认取方案 A：构造函数加 `createWhenMissing`（**默认 true** 保证既有调用方逐字节不变），bundle 层默认 **false**，DSH 显式传 true。计划文档已同步为真实签名 `createAdrBundle(config, { logger?, createWhenMissing? })`。
4. **SDK 桩的导出名必须逐一对上 core 的具名 import**：首版桩只给了 `MilvusClient/DataType/MetricType`，缺 `FunctionType/ErrorCode/RANKER_TYPE`，ESM 链接期直接报 "does not provide an export named ..."。
5. **计划里的数字有 6 处算错**（`it.each` 展开未计入），已在执行前修正；终态数字以本文档上表为准。
6. **补写了两条计划外测试**：`createWhenMissing: true` 真建目录（否则"DSH 零变化"无证据）、`fix=true` 时确实剥离锚点。
7. 自查修掉的自身缺陷：新 spec 里在模块顶层用 `beforeEach` 才赋值的 `root` 构造 fixture（两处），以及一处误写的 `await adr.service.root && ...` 无意义表达式——均在跑测试时暴露并修正。
