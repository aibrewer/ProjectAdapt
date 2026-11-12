// The outer loop: a versioned harness, the evidence each task leaves, and the
// evaluator that keeps a harness change only when it does not make tasks worse.
//
//   inner loop   one task (a turn the person started) runs on a fixed harness
//   evidence     each task is recorded: calls, failures, outcome, rating
//   meta-agent   when there is new evidence, reviews it and proposes
//   update       one proposal at a time ships as a new harness version,
//                between tasks, and only once the previous one was judged
//   evaluator    once a version has EVAL_WINDOW tasks it is compared to the
//                version before it; a worse one is rolled back automatically
//   ledger       every change and its verdict, so a rejected change is not
//                proposed again

import { clampTune, DEFAULT_TUNABLES } from './brain'
import type { Tunables } from './brain'

export type Harness = {
  version: number
  // Standing instructions the meta-agent maintains (the "Prompt" box).
  playbook: string[]
  tunables: Tunables
  // Why this version exists.
  note: string
  at: number
}

export type Task = {
  version: number
  startedAt: number
  calls: number
  failures: number
  // 'answer' | 'aborted' | 'error' | 'refusal', from turn.complete
  outcome: string
  // 1 to 5, from /rate; the evaluator's strongest signal when present.
  rating?: number
  // The person's next message read as a correction ("no, that's wrong").
  corrected?: boolean
  project?: string
}

export type Proposal =
  | { kind: 'playbook-add'; text: string; reason: string }
  | { kind: 'playbook-remove'; text: string; reason: string }
  | { kind: 'tune'; key: string; value: number; reason: string }

export type LedgerEntry = {
  version: number
  change: string
  reason: string
  status: 'trial' | 'kept' | 'rolled-back'
  at: number
  verdict?: string
}

// A self-change applied without asking, with the backup that undoes it
// (null when the change created the file).
export type Change = { at: number; file: string; backup: string | null; reason: string }

export const MAX_PLAYBOOK = 20
export const MAX_TASKS = 400
export const MAX_HISTORY = 30
export const MAX_LEDGER = 60
// Evaluator settings: constants, out of the meta-agent's reach.
export const EVAL_WINDOW = 10
export const ROLLBACK_MARGIN = 0.1

export function initialHarness(now: number): Harness {
  return { version: 1, playbook: [], tunables: { ...DEFAULT_TUNABLES }, note: 'initial', at: now }
}

// The reward of one task, in [0, 1]. A person's rating outweighs everything;
// then a correction from them, an interruption, or an error; otherwise a
// finished task scores by how cleanly its tool calls went. Failing test and
// build runs are not counted as failures (see register.ts), and a task with
// no tool calls scores by its outcome alone.
export function reward(task: Task): number {
  if (task.rating !== undefined) return (task.rating - 1) / 4
  if (task.outcome === 'aborted') return 0
  if (task.outcome !== 'answer') return 0
  if (task.corrected) return 0.25
  if (task.calls === 0) return 1

  return 1 - Math.min(1, task.failures / task.calls)
}

export function meanReward(tasks: Task[], version: number): { mean: number; n: number } {
  const own = tasks.filter(t => t.version === version)
  if (own.length === 0) return { mean: 0, n: 0 }

  return { mean: own.reduce((s, t) => s + reward(t), 0) / own.length, n: own.length }
}

export function describeProposal(p: Proposal): string {
  if (p.kind === 'tune') return `${p.key}=${p.value}`

  return `${p.kind === 'playbook-add' ? '+' : '-'}rule: ${p.text}`
}

export const isRejected = (ledger: LedgerEntry[], p: Proposal) =>
  ledger.some(l => l.status === 'rolled-back' && l.change === describeProposal(p))

// Applies ONE proposal as a new version, so its outcome can be credited to
// it. Out-of-range values are clamped; a proposal that changes nothing
// returns undefined.
export function applyOne(h: Harness, p: Proposal, now: number): Harness | undefined {
  let playbook = [...h.playbook]
  const tunables = { ...h.tunables }
  if (p.kind === 'playbook-add') {
    const text = p.text.trim()
    if (!text || playbook.includes(text)) return undefined
    playbook = [...playbook, text].slice(-MAX_PLAYBOOK)
  } else if (p.kind === 'playbook-remove') {
    if (!playbook.includes(p.text.trim())) return undefined
    playbook = playbook.filter(r => r !== p.text.trim())
  } else {
    const c = clampTune(p.key, p.value)
    if (!c || tunables[c.key] === c.value) return undefined
    tunables[c.key] = c.value
  }

  return { version: h.version + 1, playbook, tunables, note: `${describeProposal(p)} (${p.reason})`, at: now }
}

// A new version may ship only once the current one has been judged: it has
// no predecessor (the first version), or it has run EVAL_WINDOW tasks.
export function canShip(h: Harness, history: Harness[], tasks: Task[]): boolean {
  if (!history.some(v => v.version < h.version)) return true

  return meanReward(tasks, h.version).n >= EVAL_WINDOW
}

// Compares the current version to the one before it once both have enough
// tasks. Returns the version to restore, or undefined to keep going.
export function judge(current: Harness, history: Harness[], tasks: Task[]): { restore: Harness; why: string } | undefined {
  const prev = [...history].reverse().find(h => h.version < current.version)
  if (!prev) return undefined
  const now = meanReward(tasks, current.version)
  const before = meanReward(tasks, prev.version)
  if (now.n < EVAL_WINDOW || before.n < EVAL_WINDOW) return undefined
  if (now.mean >= before.mean - ROLLBACK_MARGIN) return undefined

  return {
    restore: prev,
    why: `v${current.version} scored ${now.mean.toFixed(2)} over ${now.n} tasks vs v${prev.version} ${before.mean.toFixed(2)} over ${before.n}`,
  }
}

// What the meta-agent reads: the harness, its history, the change ledger,
// how each version has done and what keeps failing.
export function evidence(h: Harness, history: Harness[], tasks: Task[], ledger: LedgerEntry[], extra: string): string {
  const versions = [...new Set(tasks.map(t => t.version))].slice(-6)
  const table = versions
    .map(v => {
      const r = meanReward(tasks, v)
      const own = tasks.filter(t => t.version === v)

      return `v${v}: ${r.n} tasks, mean reward ${r.mean.toFixed(2)}, failures ${own.reduce((s, t) => s + t.failures, 0)}/${own.reduce((s, t) => s + t.calls, 0)} calls, rated ${own.filter(t => t.rating !== undefined).length}, corrected ${own.filter(t => t.corrected).length}`
    })
    .join('\n')

  return [
    `Current harness v${h.version} (${h.note})`,
    `Playbook:\n${h.playbook.map(r => `- ${r}`).join('\n') || '(empty)'}`,
    `Tunables: ${JSON.stringify(h.tunables)}`,
    `Change ledger (do not re-propose rolled-back changes):\n${ledger.slice(-12).map(l => `v${l.version} ${l.status}: ${l.change}${l.verdict ? ` [${l.verdict}]` : ''}`).join('\n') || '(none)'}`,
    `Task outcomes by version:\n${table || '(no tasks yet)'}`,
    `Recent versions:\n${history.slice(-5).map(v => `v${v.version}: ${v.note}`).join('\n') || '(none)'}`,
    extra,
  ].join('\n\n')
}
