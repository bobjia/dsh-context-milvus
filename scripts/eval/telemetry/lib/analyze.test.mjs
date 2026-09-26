import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseJsonl, groupByTool, quartiles, bootstrapCi, pearson, formatNumber, scoreSemantics,
} from './analyze.mjs'
import { mulberry32 } from '../../retrieval/lib/stats.mjs'

test('parseJsonl skips malformed lines', () => {
  const es = parseJsonl('{"tool":"a"}\nnot json\n\n{"tool":"b"}\n')
  assert.equal(es.length, 2)
  assert.equal(es[0].tool, 'a')
})

test('groupByTool groups entries by tool', () => {
  const g = groupByTool([{ tool: 'a' }, { tool: 'b' }, { tool: 'a' }])
  assert.equal(g.a.length, 2)
  assert.equal(g.b.length, 1)
})

test('quartiles median of odd array is middle', () => {
  assert.equal(quartiles([3, 1, 2]).median, 2)
})

test('bootstrapCi contains the sample mean', () => {
  const rng = mulberry32(9)
  const { mean, lo, hi } = bootstrapCi([1, 2, 3, 4, 5], { nBoot: 500, rng })
  assert.equal(mean, 3)
  assert.ok(lo <= mean && mean <= hi)
})

test('pearson is 1 for perfectly correlated data', () => {
  assert.ok(Math.abs(pearson([1, 2, 3], [4, 5, 6]) - 1) < 1e-9)
})

test('pearson is ~0 for uncorrelated data', () => {
  assert.ok(Math.abs(pearson([1, 2, 3], [1, 1, 1])) < 1e-9)
})

test('formatNumber keeps RRF-scale scores distinguishable instead of rounding to 0.0', () => {
  // Real RRF fusion scores from ~/.milvus-index/telemetry.jsonl (k=60).
  // toFixed(1) collapsed both to "0.0" and hid the only quality signal.
  assert.equal(formatNumber(0.03151364624500275), '0.031514')
  assert.equal(formatNumber(0.032786883413791656), '0.032787')
  assert.notEqual(formatNumber(0.03151364624500275), formatNumber(0.032786883413791656))
})

test('formatNumber keeps counts and latencies readable and handles non-finite input', () => {
  assert.equal(formatNumber(47), '47.0')
  assert.equal(formatNumber(18075), '18075.0')
  assert.equal(formatNumber(0), '0')
  assert.equal(formatNumber(NaN), 'NaN')
})

test('scoreSemantics labels RRF scores as a rank encoding, not a similarity', () => {
  const lines = scoreSemantics([
    { tool: 'search_code', topScore: 0.0315, scoreKind: 'rrf', bm25RrfK: 60 },
    { tool: 'search_code', topScore: 0.74, scoreKind: 'similarity' },
  ])
  assert.ok(lines[0].includes('rrf=1'), lines[0])
  assert.ok(lines[0].includes('similarity=1'), lines[0])
  assert.ok(lines.some((l) => l.includes('1/(k+名次)')), lines.join('\n'))
  assert.ok(lines.some((l) => l.includes('bm25RrfK=60')), lines.join('\n'))
})

test('scoreSemantics counts rows predating scoreKind as unlabeled', () => {
  const lines = scoreSemantics([{ tool: 'search_code', topScore: 0.0315 }])
  assert.ok(lines[0].includes('未标注=1'), lines[0])
})
