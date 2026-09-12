# Codex MCP 移植 — 验收记录

> 执行日期：2026-09-12
> 对应计划：`docs/superpowers/plans/2026-09-06-codex-mcp-port.md`
> 执行分支：`feat/codex-mcp-port`
> 结论：**Task 1–12 全部完成并通过自动化验收；Task 13 Step 4/5 依赖真实 Milvus + Embedding + Codex CLI 会话，本环境不具备，列为待人工执行（下方给出逐条命令与判据）。**

---

## 1. 自动化验收（已执行）

环境：Node v22.23.2 / npm 10.9.8，Linux，`127.0.0.1:19530` 未开放（无 Milvus）。

| 检查项 | 命令 | 实测结果 |
|---|---|---|
| 重构前基线 | `npm ci --legacy-peer-deps && npm test` | 15 suites / **254** tests PASS（commit `c39efc2`） |
| 全量测试（重构后） | `npm test` | 23 suites / **286** tests PASS |
| 三包构建 | `npm run build` | core → dsh → codex 全部 tsc 退出码 0 |
| 类型检查 | `npm run typecheck` | 退出码 0 |
| DSH 契约路径 | `ls packages/dsh/dist/plugins/dsh-context-milvus/index.{js,d.ts}` | 存在，`main`/`types` 未变 |
| DSH 契约冻结 | `packages/dsh/test/public-surface.spec.ts` | 13 个工具名 + 27 个 Config 字段全部匹配 |
| core 边界 | `packages/core/test/core-boundary.spec.ts` | core 无 `@deepseek-ai/*` / `@modelcontextprotocol/*` / `zod`；除 `logger.ts` 外无直接 `console.*` |
| MCP stdio 冒烟 | `packages/codex/test/mcp-smoke.spec.ts` | 真实子进程：`initialize` 返回 `serverInfo.name = codex-context-milvus`；`tools/list` 返回且仅返回 `find_callers, index_code, index_status, search_code, trace_call_chain` |
| init 向导实跑 | `cd /tmp/ctx-init-demo && node packages/codex/bin/cli.js init --yes --non-interactive` | 生成 `.codex/config.toml`，含 `[mcp_servers.context-milvus]` 与 `CONTEXT_MILVUS_WORKSPACE = "/tmp/ctx-init-demo"`；未写入任何 token/key；提示行走 stderr |
| doctor 实跑 | `node packages/codex/bin/cli.js doctor` | 正确打印 workspace/milvus/embedding/项目配置；两个探针失败原因清晰（`fetch failed` / `14 UNAVAILABLE ... ECONNREFUSED 127.0.0.1:19530`）；退出码 1（符合预期，服务未启动）；stdout 无业务日志 |
| 打包内容 | `npm pack --dry-run`（三包） | core 63 文件（dist + README + LICENSE）；dsh 98 文件（dist/plugins/dsh-context-milvus + client/client.js + cordis*.yml + README + LICENSE）；codex 47 文件（dist + bin + .codex-plugin + .mcp.json + skills/context-milvus/SKILL.md + README + LICENSE） |
| 清单合法性 | `node -e "JSON.parse(...)"` | `plugin json ok` |

版本号：`dsh-context-milvus-core@0.1.0`、`dsh-context-milvus@0.6.6`、`codex-context-milvus@0.1.0`。

---

## 2. 待人工执行 A：真实 Milvus + Embedding 下的 doctor（计划 Task 13 Step 4）

前置条件：能访问 Docker Hub 与 Ollama 模型仓库。

```bash
# 1. Milvus standalone
docker run -d --name milvus -p 19530:19530 -p 9091:9091 milvusdb/milvus:latest standalone
docker logs -f milvus   # 等到 "server is ready to work"

# 2. Embedding（任选其一：Ollama 或任意 OpenAI-compatible /embed 端点）
ollama serve & ollama pull nomic-embed-text

# 3. 构建 + 体检
cd /home/bobjia/projects/dsh-context-milvus
npm ci --legacy-peer-deps && npm run build
MILVUS_ADDRESS=localhost:19530 \
EMBEDDING_ENDPOINT=http://localhost:11434/api/embed \
EMBEDDING_MODEL=nomic-embed-text \
MILVUS_EMBEDDING_DIM=768 \
node packages/codex/bin/cli.js doctor
echo "exit=$?"
```

判据（全部满足才算通过）：

- [ ] `embedding probe: ok (dim=768)`
- [ ] `milvus probe: ok`
- [ ] 退出码 `0`
- [ ] stdout 完全为空（所有行都在 stderr）

常见失败与含义：

| 现象 | 原因 |
|---|---|
| `dim=` 与 `MILVUS_EMBEDDING_DIM` 不一致 | 集合维度与实际模型不符，首次 `index_code` 会报维度错；改 `MILVUS_EMBEDDING_DIM` 或删除旧集合 |
| embedding ok 但 milvus `UNAVAILABLE` | Milvus 尚未 ready，或地址写成 http 前缀（此处要 `host:port`，不带 scheme） |
| 旧集合被重命名 | 日志出现「检测到旧版纯向量集合 ... 已重命名为 ..._legacy_*」，属预期的 hybrid schema 升级，需再跑 `index_code(mode=full)` |

---

## 3. 待人工执行 B：Codex CLI 端到端（计划 Task 13 Step 5）

前置条件：`codex --version` ≥ 0.147，已完成上一节（Milvus + Embedding 可达），并已完成 `npm link` 或用本地路径。

```bash
cd /home/bobjia/projects/dsh-context-milvus/packages/codex && npm link   # 或 npm i -g codex-context-milvus

codex mcp add context-milvus -- npx -y codex-context-milvus mcp
codex mcp list                                                            # 应列出 context-milvus

cd /home/bobjia/projects/dsh-context-milvus
codex exec "先调用 index_status；如果从未索引就调用 index_code mode=full；然后搜索 semantic search 的实现位置"
```

判据：

- [ ] Codex 依次成功调用 `index_status` → `index_code` → `search_code`，无 MCP 层报错
- [ ] `search_code` 命中 `packages/core/src/milvus-service.ts` 相关片段（结果里含绝对路径 + 行号区间 + 相关度）
- [ ] 返回体同时含可读文本与 `structuredContent`
- [ ] 再次运行 `codex exec "... 只调用 index_status"`，第二次索引为增量（`新增/修改` 文件数为 0 或很小）
- [ ] `find_callers(symbol="runIndex")` 能列出 `packages/dsh/src/plugins/dsh-context-milvus/tools.ts` 的调用点

补充人工项（可选，验证插件形态而非仅 MCP）：

- [ ] `codex plugin marketplace add <本地 packages/codex 路径>` 能识别 `.codex-plugin/plugin.json`，且 `skills/context-milvus` 出现在技能列表

> 注意：MCP server 子进程运行在 Codex 的 OS 沙箱之外，`index_code` 会写 `~/.milvus-index/` 下的状态文件；这是能力也是安全面，需在文档中保持声明（已写入 `packages/codex/README.md`）。

---

## 4. 已知限制（与规格一致，非缺陷）

- Codex 侧只有 5 个检索工具；**8 个 ADR 工具未移植**，ADR 约束的运行时注入在 Codex 无等价生命周期钩子。
- 无运行时热更新：改配置必须改 `config.toml` 并重启 Codex。
- 未接入 MCP Roots，工作区靠「显式 path → 向上找 `.git` → cwd」三级规则。
- Windows 未验证（tree-sitter 原生模块 prebuild 覆盖情况未知）。
- 未发布 marketplace（规格列为非目标）；`.codex-plugin/plugin.json` 仅保证可被解析。
- 大仓库首次 `index_code(mode=full)` 是长阻塞调用，建议先在终端跑全量、会话内只做增量。

---

## 5. 执行期间的计划偏差（供复核）

计划中有 9 处与仓库/环境实际情况不符，均按「保持行为不变、修正测试或命令」的原则处理，未改动任何对外契约：

1. **Task 1 Step 7 跳过**：该 sed 会在文件尚未真正搬出 `src/plugins/dsh-context-milvus/` 前就把测试导入压平，导致 Step 8 的「15 suites PASS」无法成立。改为在 Task 2 一并处理，并把 Task 2 Step 7 的正则放宽以覆盖未压平的路径。
2. **Task 2 Step 7 拆分处理**：被 `jest.unstable_mockModule` 拦截的 core 模块改为指向 `../../core/src/*.js`（在同一路径上打桩，仍能透过 barrel 生效）；普通真实引用才替换为包名。
3. **DSH 测试补 SDK 桩**：`tools.ts`/`adr-tools.ts` 现在经由 core barrel 引入 `milvus-service`，会在加载期拉起真实 Milvus SDK；`adr-tools.spec.ts` 增加 SDK 桩，`adr-types.spec.ts` 改为直接引用 `../../core/src/config.js`。
4. **`typecheck` 先构建 core**：计划原式 `tsc -p packages/dsh --noEmit` 在干净工作树上报 20 个 TS2307（`dsh-context-milvus-core` 的 `types` 指向尚未构建的 `dist/index.d.ts`）。
5. **单文件测试命令**：计划写 `npx jest <file>`，本仓库 ESM 必须用 `node --experimental-vm-modules node_modules/.bin/jest <file>`。
6. **`npm install` 需 `--legacy-peer-deps`**：既有 peer 冲突（`@deepseek-ai/dsh-llm` 与 `@deepseek-ai/dsh-settings` 对 `dsh-brand` 的要求互斥），与本次重构无关。
7. **Task 8/9 测试桩与断言修正**：`runIndex` 会展开 `config.ignorePatterns` 并读取 `config.embedding`，故测试用 `getConfig()` 造真实 `PluginConfig`；tracker 桩补 `computeDelta`、importResolver 桩补 `save/removeFile`；`traceChain` 实际总会压入一个 depth-0 入口节点，断言按真实行为写。
8. **Task 7 envelope 由 interface 改 type**：MCP SDK 的 `CallToolResult` 带字符串索引签名，TS 不会给 interface 隐式索引签名（5 处 TS2345）。
9. **Task 11 测试修正**：计划给出的 spec 缺 `import { tmpdir } from 'node:os'`；且「第二次写入应产生备份」与自身「幂等不写文件」的要求冲突，改为断言「无变化不写不备份 / 有变化才备份」，另用不同 model 验证备份内容确为旧内容。

另有 3 处小的补齐：计划里的绝对路径 `/mnt/home/bobjia/workspace/...` 全部替换为真实路径；根 `package.json` 保留 `test:eval*`（`scripts/` 仍在根，删掉即失去评测入口）；core 与 dsh、codex 三个包各补 `README.md` + `LICENSE`（原单包形态会发布这两个文件，拆分后若缺失即为发布内容回退）。
