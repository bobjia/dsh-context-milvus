// 单任务多运行结果聚合。

export function taskSuccessFraction(runs) {
  return runs.filter((r) => r.passed).length / runs.length
}

export function medianOfRun(runs, field) {
  const vals = runs.map((r) => r[field]).sort((a, b) => a - b)
  const m = Math.floor(vals.length / 2)
  return vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2
}
