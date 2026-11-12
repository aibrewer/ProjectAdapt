import { expect, test } from 'claude-code/testing'

import { classify } from './autonomy'
import { endTask } from './boundary'
import type { Boundary } from './boundary'
import { normalizeTunables } from './brain'
import { applyOne, EVAL_WINDOW, initialHarness, reward } from './harness'
import type { Task } from './harness'

const ROOT = 'C:\\Users\\me\\projectadapt'
const SETTINGS = 'C:\\Users\\me\\.claude\\settings.json'

test('any change to its own code goes through: big edits, rewrites, new files', async () => {
  expect(classify('Edit', { file_path: `${ROOT}\\hooks\\brain.ts`, old_string: 'limit = 3', new_string: 'limit = 4' }, ROOT)?.tier).toBe('minor')
  expect(classify('Edit', { file_path: `${ROOT}\\hooks\\brain.ts`, old_string: 'a', new_string: 'x\n'.repeat(300) }, ROOT)?.tier).toBe('minor')
  expect(classify('Write', { file_path: `${ROOT}\\hooks\\brain.ts`, content: 'x' }, ROOT)?.tier).toBe('minor')
  expect(classify('Write', { file_path: `${ROOT}\\hooks\\newskill.ts`, content: 'x' }, ROOT)?.tier).toBe('minor')
})

test('only the permission rules, the manifest and their wiring need a yes', async () => {
  expect(classify('Edit', { file_path: `${ROOT}\\hooks\\autonomy.ts`, old_string: 'a', new_string: 'b' }, ROOT)?.tier).toBe('major')
  expect(classify('Write', { file_path: `${ROOT}\\hooks\\autopilot.ts`, content: 'x' }, ROOT)?.tier).toBe('major')
  expect(classify('Edit', { file_path: `${ROOT}\\.claude-plugin\\plugin.json`, old_string: 'a', new_string: 'b' }, ROOT)?.tier).toBe('major')
  expect(classify('Edit', { file_path: `${ROOT}\\hooks\\register.ts`, old_string: "on('tool.check', a)", new_string: 'x' }, ROOT)?.tier).toBe('major')
  expect(classify('Edit', { file_path: `${ROOT}\\hooks\\register.ts`, old_string: 'const a = 1', new_string: 'const a = 2' }, ROOT)?.tier).toBe('minor')
})

test('adding a read-only permission is minor; anything broader is major', async () => {
  const before = '"allow": [\n  "Read"\n]'
  expect(classify('Edit', { file_path: SETTINGS, old_string: before, new_string: '"allow": [\n  "Read",\n  "Bash(git status:*)"\n]' }, ROOT)?.tier).toBe('minor')
  expect(classify('Edit', { file_path: SETTINGS, old_string: before, new_string: '"allow": [\n  "Read",\n  "Bash(*)"\n]' }, ROOT)?.tier).toBe('major')
})

test('tunables stay inside their bounds, and old data gets defaults', async () => {
  const h = applyOne(initialHarness(0), { kind: 'tune', key: 'lessonsInPrompt', value: 999, reason: 'more' }, 1)
  expect(h?.tunables.lessonsInPrompt).toBe(25)
  expect(applyOne(initialHarness(0), { kind: 'tune', key: 'evalWindow', value: 50, reason: 'game the judge' }, 1)).toBe(undefined)
  const fixed = normalizeTunables({ halfLifeDays: 10 } as never)
  expect(fixed.halfLifeDays).toBe(10)
  expect(fixed.repeatWeight).toBe(3)
})

test('reward: tests are not mistakes, corrections and interruptions count', async () => {
  const base: Task = { version: 1, startedAt: 0, calls: 0, failures: 0, outcome: 'answer' }
  expect(reward(base)).toBe(1)
  expect(reward({ ...base, outcome: 'aborted' })).toBe(0)
  expect(reward({ ...base, corrected: true })).toBe(0.25)
  expect(reward({ ...base, rating: 5, corrected: true })).toBe(1)
})

const tasks = (version: number, n: number, failures: number): Task[] =>
  Array.from({ length: n }, () => ({ version, startedAt: 0, calls: 10, failures, outcome: 'answer' }))

test('one change ships at a time, and only after the last was judged', async () => {
  const add = (text: string) => ({ kind: 'playbook-add' as const, text, reason: 'try' })
  let state: Boundary = { h: initialHarness(0), history: [], queue: [add('A'), add('B')], ledger: [], tasks: [] }
  const first = endTask(state, undefined, 1)
  expect(first.h.version).toBe(2)
  expect(first.queue.length).toBe(1)
  // v2 has not run EVAL_WINDOW tasks yet: B waits.
  const waiting = endTask(first, tasks(2, 1, 0)[0], 2)
  expect(waiting.h.version).toBe(2)
  state = { ...waiting, tasks: [...waiting.tasks, ...tasks(2, EVAL_WINDOW, 0)] }
  expect(endTask(state, undefined, 3).shipped).toBe('+rule: B')
})

test('a version that does worse is rolled back and the lesson names the bad change', async () => {
  const v1 = initialHarness(0)
  const v2 = applyOne(v1, { kind: 'playbook-add', text: 'Always do X', reason: 'try' }, 1)
  if (!v2) throw new Error('no v2')
  const ledger = [{ version: 2, change: '+rule: Always do X', reason: 'try', status: 'trial' as const, at: 1 }]
  const r = endTask({ h: v2, history: [v1], queue: [], ledger, tasks: [...tasks(1, EVAL_WINDOW, 0), ...tasks(2, EVAL_WINDOW - 1, 6)] }, tasks(2, 1, 6)[0], 2)

  expect(r.rolledBack?.change).toBe('+rule: Always do X')
  expect(r.h.playbook.length).toBe(0)
  expect(r.ledger[0]?.status).toBe('rolled-back')
  // The rejected change is never shipped again.
  const again = endTask({ ...r, queue: [{ kind: 'playbook-add', text: 'Always do X', reason: 'retry' }] }, undefined, 3)
  expect(again.shipped).toBe(undefined)
})
