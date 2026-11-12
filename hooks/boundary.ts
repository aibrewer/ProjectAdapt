// The task boundary as a pure function: given the harness state and the task
// that just ended, decide the verdict on the version under trial and whether
// the next queued change ships. register.ts reads the store, calls this, and
// writes back what it returns.

import { applyOne, canShip, describeProposal, EVAL_WINDOW, isRejected, judge, MAX_HISTORY, MAX_LEDGER, MAX_TASKS, meanReward } from './harness'
import type { Harness, LedgerEntry, Proposal, Task } from './harness'

export type Boundary = {
  h: Harness
  history: Harness[]
  queue: Proposal[]
  ledger: LedgerEntry[]
  tasks: Task[]
}

export type BoundaryResult = Boundary & {
  // The change that made things worse, and why it was rolled back.
  rolledBack?: { change: string; why: string }
  kept?: string
  shipped?: string
}

export function endTask(state: Boundary, task: Task | undefined, now: number): BoundaryResult {
  let { h, history, queue, ledger } = state
  const tasks = task ? [...state.tasks, task].slice(-MAX_TASKS) : state.tasks
  const out: Partial<BoundaryResult> = {}

  // Judge against versions that were not themselves rolled back, so a
  // restored copy is never compared to the bad version it replaced.
  const rejected = new Set(ledger.filter(l => l.status === 'rolled-back').map(l => l.version))
  const verdict = judge(h, history.filter(v => !rejected.has(v.version)), tasks)
  const trial = ledger.find(l => l.version === h.version && l.status === 'trial')
  if (verdict) {
    out.rolledBack = { change: trial?.change ?? h.note, why: verdict.why }
    ledger = ledger.map(l => (l === trial ? { ...l, status: 'rolled-back' as const, verdict: verdict.why } : l))
    history = [...history, h].slice(-MAX_HISTORY)
    h = { ...verdict.restore, version: h.version + 1, note: `rollback of v${h.version}: ${verdict.why}`, at: now }
  } else if (trial && meanReward(tasks, h.version).n >= EVAL_WINDOW) {
    out.kept = trial.change
    ledger = ledger.map(l => (l === trial ? { ...l, status: 'kept' as const, verdict: `kept after ${EVAL_WINDOW} tasks` } : l))
  }

  if (!out.rolledBack && queue.length > 0 && canShip(h, history, tasks)) {
    const rest = [...queue]
    while (rest.length > 0) {
      const p = rest.shift() as Proposal
      if (isRejected(ledger, p)) continue
      const next = applyOne(h, p, now)
      if (!next) continue
      history = [...history, h].slice(-MAX_HISTORY)
      ledger = [...ledger, { version: next.version, change: describeProposal(p), reason: p.reason, status: 'trial' as const, at: now }].slice(-MAX_LEDGER)
      h = next
      out.shipped = describeProposal(p)
      break
    }
    queue = rest
  }

  return { ...out, h, history, queue, ledger, tasks }
}
