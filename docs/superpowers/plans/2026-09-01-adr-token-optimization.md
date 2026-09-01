# ADR Token Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce ADR token waste to zero by default (ADR off) and when enabled (advisory rules, short summary, no timer-based message injection).

**Architecture:** Three independent changes: (1) config defaults, (2) system prompt + constraint summary format, (3) pre-step hook logic. All changes are in `config.ts` and `constraint-injector.ts` (plus test updates).

**Tech Stack:** TypeScript, jest, DSH plugin framework

## Global Constraints

- `adrEnabled` default: `process.env.ADR_ENABLED === 'true'` (false unless explicitly opted in)
- `adrConstraintReinjectEvery` default: `0` (disabled)
- When `adrEnabled` is false, the plugin registers zero ADR tools, hooks, or system prompt
- When `adrConstraintReinjectEvery` is 0, `constraintCache` stays empty — no constraint summary in system prompt
- When `adrConstraintReinjectEvery > 0`, cache still refreshes on timer, but no `createUserMessage` is injected from the timer — only from pending file-modification warnings
- Shared summary format for warnings: `ADR-XXXX (N 约束, M 隐性约束, K 反模式)` — not full text

---

### Task 1: Config Defaults

**Files:**
- Modify: `src/plugins/dsh-context-milvus/config.ts:215-224`
- Test: `test/dsh-context-remdb.spec.ts` (config section, add ADR default tests)

**Interfaces:**
- Consumes: `config.ts` PluginConfig type, `getConfig()` function
- Produces: new defaults: `adrEnabled=false`, `adrConstraintReinjectEvery=0`

- [ ] **Step 1: Change `adrEnabled` default to false**

In `config.ts` line 215-217, change:
```typescript
// Before:
adrEnabled: overrides?.adrEnabled !== undefined
  ? overrides.adrEnabled
  : process.env.ADR_ENABLED !== 'false',

// After:
adrEnabled: overrides?.adrEnabled !== undefined
  ? overrides.adrEnabled
  : process.env.ADR_ENABLED === 'true',
```

- [ ] **Step 2: Change `adrConstraintReinjectEvery` default to 0**

In `config.ts` line 220-223, change:
```typescript
// Before:
const raw = overrides?.adrConstraintReinjectEvery ?? parseInt(process.env.ADR_REINJECT_EVERY ?? '', 10)
return !isNaN(raw) && raw >= 0 ? raw : 5

// After:
const raw = overrides?.adrConstraintReinjectEvery ?? parseInt(process.env.ADR_REINJECT_EVERY ?? '', 10)
return !isNaN(raw) && raw >= 0 ? raw : 0
```

- [ ] **Step 3: Add ADR default tests in `test/dsh-context-remdb.spec.ts`**

Add a new test block (or extend existing config test block) to verify:

```typescript
// After the existing config tests
it('sets adrEnabled default to false', () => {
  const cfg = getConfig()
  expect(cfg.adrEnabled).toBe(false)
})

it('sets adrConstraintReinjectEvery default to 0', () => {
  const cfg = getConfig()
  expect(cfg.adrConstraintReinjectEvery).toBe(0)
})
```

- [ ] **Step 4: Run tests to verify**

```bash
node --experimental-vm-modules node_modules/.bin/jest --no-coverage
```

Expected: 130+ tests pass (new config tests added).

- [ ] **Step 5: Commit**

```bash
git add src/plugins/dsh-context-milvus/config.ts test/dsh-context-remdb.spec.ts
git commit -m "feat: default ADR off (adrEnabled=false, reinjectEvery=0)"
```

---

### Task 2: System Prompt & Constraint Summary Format

**Files:**
- Modify: `src/plugins/dsh-context-milvus/constraint-injector.ts:26-48` (DEFAULT_SYSTEM_PROMPT), `:64-76` (buildConstraintSummary)

**Interfaces:**
- Consumes: `ConstraintSummary` type from `./types.js`
- Produces: `DEFAULT_SYSTEM_PROMPT` (advisory rules), `buildConstraintSummary` (short format)

- [ ] **Step 1: Change `DEFAULT_SYSTEM_PROMPT` to advisory rules**

Replace the existing `DEFAULT_SYSTEM_PROMPT` (lines 26-48) with:

```typescript
const DEFAULT_SYSTEM_PROMPT = `## 决策记忆系统规则

你是本项目的 AI 编码 Agent。本项目部署了决策因果记忆系统（Decision Causal Memory System）。

### 你必须遵守的规则：

1. **修改有 ADR 覆盖的文件时**：
   - 如修改的文件有 ADR 决策记录覆盖，建议先使用 search_adr_by_file 查询相关 ADR
   - 根据 ADR 约束调整实现方案，避免违反已有决策

2. **执行代码变更时**：
   - 如变更触发 ADR 产出条件（新模块/核心逻辑修改/新依赖/非常规bugfix/架构变更/删除逻辑）
   - 必须使用 create_adr 或 update_adr 工具生成或更新对应的 ADR

3. **创建或更新 ADR 后**：
   - 使用 check_adr_consistency 确认 ADR 与代码一致
   - 确认隐性约束和被否决的反模式字段已填写完整

4. **禁止行为**：
   - ❌ 跳过 ADR 产出（声称"这是小改动"）
   - ❌ 生成只有 WHAT 没有 WHY 的空洞 ADR
   - ❌ 忽略已加载 ADR 中的隐性约束
   - ❌ 重新尝试已被 ADR 否决的方案`
```

Key changes from original:
- Rule 1: "开始任何任务前必须使用 search_adr_by_file" → "修改有 ADR 覆盖的文件时，建议先查询"
- Rule 3: "完成任务前必须使用 check_adr_consistency" → "创建或更新 ADR 后使用 check_adr_consistency"

- [ ] **Step 2: Change `buildConstraintSummary` to short format**

Replace the existing `buildConstraintSummary` function (lines 64-76) with:

```typescript
/**
 * Build a short constraint summary from active ADR constraints.
 * Returns a compact format listing ADR ID + constraint counts,
 * not the full constraint text. Users can call load_constraints
 * for full details.
 */
function buildConstraintSummary(constraints: ConstraintSummary[]): string {
  if (constraints.length === 0) return ''
  const parts = constraints.map(c => {
    const items: string[] = []
    if (c.constraints.length > 0) items.push(`${c.constraints.length} 约束`)
    if (c.hiddenConstraints.length > 0) items.push(`${c.hiddenConstraints.length} 隐性约束`)
    if (c.rejectedPatterns.length > 0) items.push(`${c.rejectedPatterns.length} 反模式`)
    return `${c.adrId} (${items.join(', ')})`
  })
  return `当前 Active ADR: ${parts.join('; ')}`
}
```

- [ ] **Step 3: Run tests to verify**

```bash
node --experimental-vm-modules node_modules/.bin/jest --no-coverage
```

Expected: The constraint-injector tests that check `buildConstraintSummary` or `contextResult.text()` may need minor assertion updates (the text format changed). Fix any test assertions that check the old verbose format.

- [ ] **Step 4: Commit**

```bash
git add src/plugins/dsh-context-milvus/constraint-injector.ts test/constraint-injector.spec.ts
git commit -m "feat: advisory system prompt rules and short constraint summary format"
```

---

### Task 3: Pre-step Hook — Remove Timer-Based Message Injection

**Files:**
- Modify: `src/plugins/dsh-context-milvus/constraint-injector.ts:129-153` (pre-step hook timer block)
- Modify: `test/constraint-injector.spec.ts` (update runtime behavior tests)

**Interfaces:**
- Consumes: `resolveConfig()`, `adrService`, `sessionState`, `constraintCache`
- Produces: pre-step hook that refreshes cache on timer but only injects `createUserMessage` from pending warnings

- [ ] **Step 1: Modify pre-step hook timer block**

In `constraint-injector.ts`, change the timer block (lines 129-153) to refresh cache but NOT inject the constraint text as a warning:

```typescript
    // Async refresh constraint cache (no message injection — the system
    // prompt context() provider reads the cache synchronously).
    if (reinjectEvery > 0 && state.stepCount % reinjectEvery === 0) {
      try {
        // Resolve the ADR root against the session workspace when available.
        const sessionCwd = agent?.session?.header?.cwd as string | undefined
        let svc = adrService
        if (sessionCwd) {
          const config = resolveConfig()
          const effectiveRoot = path.resolve(sessionCwd, config.adrRoot || 'docs/decisions')
          if (effectiveRoot !== adrService.root) {
            svc = new AdrService(effectiveRoot)
          }
        }

        const constraints = await svc.getActiveConstraints()
        constraintCache = buildConstraintSummary(constraints)
      } catch {
        // Silently handle errors
      }
    }
```

Key change: removed the `warnings.push(...)` block that injected the verbose constraint text into the message stream. The cache is still refreshed for `systemPrompt.context()`.

- [ ] **Step 2: Update the "refreshes constraint cache" test**

In `test/constraint-injector.spec.ts`, update the runtime behavior test. The test "refreshes constraint cache and injects warnings on pre-step" currently expects `createUserMessage` to be called from the timer. Change it to:

```typescript
it('refreshes constraint cache on pre-step without injecting warnings', async () => {
  resolveConfig.mockReturnValue({
    adrEnabled: true,
    adrConstraintReinjectEvery: 1,
    adrSystemPrompt: '',
  })
  const constraints = [
    {
      adrId: 'ADR-0001',
      adrTitle: 'Test Decision',
      constraints: ['Must be fast'],
      hiddenConstraints: [],
      rejectedPatterns: ['no X'],
      status: 'active',
    },
  ]
  adrService.getActiveConstraints.mockResolvedValue(constraints)

  setupConstraintInjection(ctx, resolveConfig, adrService, anchorIndex)
  const preStepHook = getPreStepHook()

  const claimedMessage = { role: 'user', content: 'claimed' }
  const decision = { kind: 'normal', messages: [claimedMessage] }
  const next = jest.fn().mockResolvedValue(decision)
  const agent = { session: { id: 'session-1' } }

  const result = await preStepHook({ agent, messages: [claimedMessage], step: {} }, next)

  // next middleware ran
  expect(next).toHaveBeenCalled()

  // constraint cache was refreshed (system prompt context reads this)
  expect(adrService.getActiveConstraints).toHaveBeenCalled()
  // The short summary format is used for the cache
  expect(contextResult.text()).toContain('ADR-0001')
  expect(contextResult.text()).toContain('1 约束')

  // No createUserMessage from timer — only from pending file warnings
  expect(mockCreateUserMessage).not.toHaveBeenCalled()

  // Decision is returned unchanged (no messages injected)
  expect(result.messages).toHaveLength(1)
})
```

- [ ] **Step 3: Keep the "skips re-injection when interval not reached" test, add a default-disabled test**

The existing test "skips re-injection when the step interval is not reached" (with `reinjectEvery: 5`, stepCount=1) should be kept as-is — it still works because `1 % 5 !== 0`.

Add a new test for the default-disabled case:

```typescript
it('does not refresh constraint cache when reinjectEvery is 0 (default)', async () => {
  resolveConfig.mockReturnValue({
    adrEnabled: true,
    adrConstraintReinjectEvery: 0,  // default — disabled
    adrSystemPrompt: '',
  })
  setupConstraintInjection(ctx, resolveConfig, adrService, anchorIndex)
  const preStepHook = getPreStepHook()

  const decision = { kind: 'normal', messages: [] }
  const next = jest.fn().mockResolvedValue(decision)
  const agent = { session: { id: 'session-2' } }

  const result = await preStepHook({ agent, messages: [], step: {} }, next)

  // reinjectEvery=0 → the if (reinjectEvery > 0) guard prevents any refresh
  expect(adrService.getActiveConstraints).not.toHaveBeenCalled()
  expect(mockCreateUserMessage).not.toHaveBeenCalled()
  expect(result).toBe(decision)
})
```

- [ ] **Step 4: Keep the "warns on edit tool results" test**

The test "warns on edit tool results for anchored files and injects on pre-step" should still pass as-is — it tests the `tools/result` → `pendingWarnings` → `createUserMessage` flow, which is unchanged. No modification needed.

- [ ] **Step 5: Run all tests**

```bash
node --experimental-vm-modules node_modules/.bin/jest --no-coverage
```

Expected: 130+ tests pass. Fix any test assertion failures from the format changes.

- [ ] **Step 6: Commit**

```bash
git add src/plugins/dsh-context-milvus/constraint-injector.ts test/constraint-injector.spec.ts
git commit -m "feat: pre-step hook refreshes cache only, no timer-based message injection"
```

---

### Task 4: Documentation Update

**Files:**
- Modify: `AGENTS.md`, `CLAUDE.md`, `README.md`

- [ ] **Step 1: Update `AGENTS.md`**

In the ADR 决策记忆使用规则 section:
1. Add a note about ADR default state at the top
2. Change rule 1 from mandatory to advisory
3. Change rule 4 from mandatory to advisory

```markdown
## ADR 决策记忆使用规则

> **注意：** ADR 功能默认关闭。如需启用，设置环境变量 `ADR_ENABLED=true` 或在配置中设置 `adrEnabled: true`。

1. **修改有 ADR 覆盖的代码前**，建议先调用 `search_adr_by_file` 确认该文件是否有 ADR 决策记录覆盖
2. **做出设计决策**（新功能/重构/架构变更/新依赖）时，使用 `create_adr` 记录决策原因
3. **修改了被 ADR 覆盖的代码**后，使用 `update_adr` 更新对应 ADR 的 code_anchors
4. **创建或更新 ADR 后**，建议调用 `check_adr_consistency` 确认一致性
5. **需要了解约束**时，使用 `load_constraints` 查看 active ADR 的约束条件
```

- [ ] **Step 2: Update `CLAUDE.md`**

In the Architecture → ADR 决策记忆系统 section, add a note about default state:

In the ADR module list, add:
```
ADR 默认关闭（adrEnabled: false），通过 ADR_ENABLED=true 或配置启用
```

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md CLAUDE.md README.md
git commit -m "docs: update ADR documentation for default-off state"
```

---

### Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-09-01-adr-token-optimization.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**