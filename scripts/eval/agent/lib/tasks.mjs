import { readFile } from 'node:fs/promises'

export async function loadTasks(filePath) {
  const raw = await readFile(filePath, 'utf8')
  const data = JSON.parse(raw)
  if (!Array.isArray(data.tasks)) throw new Error('task set must have a "tasks" array')
  for (const t of data.tasks) {
    if (!t.id || !t.repo || !t.baseCommit || !t.goldPatch || !t.testCommand) {
      throw new Error('each task needs { id, repo, baseCommit, goldPatch, testCommand }')
    }
  }
  return data.tasks
}
