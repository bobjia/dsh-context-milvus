# ADR Token Optimization — Design

Date: 2026-09-01
Status: Approved (approach + design sections confirmed by user)

## Context

The Decision Causal Memory System (ADR plugin) currently defaults to enabled
(`adrEnabled: true`) and injects mandatory system prompt rules that force the
agent to call `search_adr_by_file` for every file before any task and
`check_adr_consistency` before completing a task. On a commit operation with
many files, this generates excessive tool calls and token waste.

Additionally, the constraint re-injection pre-step hook injects the full
constraint text (including all hidden constraints with content and consequence)
every 5 steps as a `createUserMessage`, consuming significant token budget
even when the agent does not need the information.

## Scope

Two changes:

1. **Default ADR off** — reduce overhead to zero when the user has not
   explicitly opted in.
2. **Optimize token usage when ADR is enabled** — advisory rules instead of
   mandatory per-file checks, constraint re-injection only on file-change
   warnings with short summary format.

## Config Defaults

### `adrEnabled` — default false

```typescript
// Before (defaults to true):
process.env.ADR_ENABLED !== 'false'

// After (defaults to false):
process.env.ADR_ENABLED === 'true'
```

### `adrConstraintReinjectEvery` — default 0 (disabled)

```typescript
// Before (defaults to 5):
const raw = overrides?.adrConstraintReinjectEvery ??
  parseInt(process.env.ADR_REINJECT_EVERY ?? '', 10)
return !isNaN(raw) && raw >= 0 ? raw : 5

// After (defaults to 0):
const raw = overrides?.adrConstraintReinjectEvery ??
  parseInt(process.env.ADR_REINJECT_EVERY ?? '', 10)
return !isNaN(raw) && raw >= 0 ? raw : 0
```

When `adrEnabled` is false, the plugin registers zero ADR tools, zero
lifecycle hooks, and zero system prompt sections — completely zero overhead.

## System Prompt Rules (when ADR is enabled)

Change from mandatory to advisory:

| Rule | Before | After |
|------|--------|-------|
| 1 | 开始任何任务前 → 必须使用 search_adr_by_file | 修改有 ADR 覆盖的文件时 → 建议先查询相关 ADR |
| 2 | 不变 | 不变（执行变更时，如触发条件必须创建/更新 ADR） |
| 3 | 完成任务前 → 必须使用 check_adr_consistency | 创建或更新 ADR 后 → 使用 check_adr_consistency |
| 4 | 不变 | 不变（禁止行为） |

## Constraint Re-injection (when ADR is enabled)

### Default: disabled

`adrConstraintReinjectEvery: 0` means the pre-step hook never triggers a
periodic constraint refresh. The `constraintCache` (read by
`systemPrompt.context()`) stays empty, so the system prompt shows no
constraint summary — the desired zero-overhead default.

### When enabled by user

When `adrConstraintReinjectEvery > 0`:

- The pre-step hook still refreshes the `constraintCache` on timer (so
  `systemPrompt.context()` returns fresh data).
- **No `createUserMessage` is injected** from the timer-based refresh.
- `createUserMessage` is only injected when the `tools/result` hook has
  collected **pending file-modification warnings** (write/edit on an anchored
  file).

### Summary format (short)

When a warning IS injected, the message uses a short summary format instead
of the full constraint text:

```
⚠️ 文件修改提醒: 你修改了 src/x.ts，它被以下 ADR 覆盖:
  - ADR-0001 (4 约束, 2 隐性约束, 1 反模式)
  - ADR-0003 (4 约束, 3 隐性约束)
如需查看完整约束内容，请使用 load_constraints format=full
```

The full constraint text is still available on demand via `load_constraints`.

## Files Changed

### Source files

| File | Change |
|------|--------|
| `src/plugins/dsh-context-milvus/config.ts` | `adrEnabled` default → false; `adrConstraintReinjectEvery` default → 0 |
| `src/plugins/dsh-context-milvus/constraint-injector.ts` | `DEFAULT_SYSTEM_PROMPT` → advisory rules; pre-step hook → no timer-based `createUserMessage`; `buildConstraintSummary` → short format |

### Test files

| File | Change |
|------|--------|
| `test/constraint-injector.spec.ts` | Update runtime behavior tests for new logic (short summary, no timer injection by default); add test for short summary format |
| `test/dsh-context-remdb.spec.ts` (config section) | Update `adrEnabled` default test to false; `adrConstraintReinjectEvery` default test to 0 |

### Documentation

| File | Change |
|------|--------|
| `AGENTS.md` | Update ADR section — note default off, enable via `ADR_ENABLED=true` |
| `CLAUDE.md` | Update Architecture section — note default off |
| `README.md` | Update enabling instructions |

## Verification

- All tests pass (130 → ~133 tests)
- `npm run build` clean
- Default config = zero ADR overhead (no tools, no hooks, no system prompt)
- `ADR_ENABLED=true` → full ADR functionality with advisory rules
- `ADR_ENABLED=true & ADR_REINJECT_EVERY=5` → timer-refreshed cache + short
  warnings on file modification