// The one place that names what ProjectAdapt keeps across chats ($.store) and how
// it is read and written. Every write goes through `update`, which runs one
// change at a time per key, so two hooks finishing together cannot overwrite
// each other. Per-chat values are atoms over $.state (session state).

import { atom, read, update as updateAtom } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Autopilot, Live, LogEntry, MetaRun, SelfEdit } from '../types'
import { normalizeTunables } from './brain'
import type { FailureGroup, Goal, Lesson, Memory } from './brain'
import { initialHarness } from './harness'
import type { Change, Harness, LedgerEntry, Proposal, Task } from './harness'
import type { Project } from './projects'

export const SCHEMA = 3
// Longest text kept for a fact, rule, goal, milestone or log line.
export const CAP = 500

export const cap = (s: string, n = CAP) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

type Key<T> = { name: string; empty: () => T }
const key = <T>(name: string, empty: () => T): Key<T> => ({ name, empty })

export const K = {
  lessons: key<Lesson[]>('lessons', () => []),
  memories: key<Memory[]>('memories', () => []),
  failures: key<FailureGroup[]>('failures', () => []),
  // Append-only: failure counts by harness version and signature.
  histogram: key<Record<string, Record<string, number>>>('histogram', () => ({})),
  goals: key<Record<string, Goal>>('goals', () => ({})),
  goalsDone: key<Goal[]>('goals-done', () => []),
  projects: key<Record<string, Project>>('projects', () => ({})),
  harness: key<Harness | null>('harness', () => null),
  history: key<Harness[]>('harness-history', () => []),
  queue: key<Proposal[]>('harness-queue', () => []),
  ledger: key<LedgerEntry[]>('ledger', () => []),
  tasks: key<Task[]>('tasks', () => []),
  journal: key<Change[]>('journal', () => []),
  recommendations: key<string[]>('recommendations', () => []),
  // New evidence since the meta-agent last ran: new failure kinds, ratings.
  metaEvidence: key<number>('meta-evidence', () => 0),
  schema: key<number>('schema', () => 0),
}

// Session state is read and written only here: the engine's scan requires
// each atom to be used in the file that declares it.
const project = atom({ plugin: 'projectadapt', key: 'project' } as const, '')
const autopilot = atom({ plugin: 'projectadapt', key: 'autopilot' } as const, null as Autopilot | null)
const live = atom({ plugin: 'projectadapt', key: 'live' } as const, { calls: 0, failures: 0, progressed: false, repeated: [] } as Live)
const away = atom({ plugin: 'projectadapt', key: 'away' } as const, [] as string[])
const meta = atom({ plugin: 'projectadapt', key: 'meta' } as const, null as MetaRun | null)
const compose = atom({ plugin: 'projectadapt', key: 'compose' } as const, '')
const origin = atom({ plugin: 'projectadapt', key: 'origin' } as const, 'user' as 'user' | 'plugin')
const logQueue = atom({ plugin: 'projectadapt', key: 'logQueue' } as const, [] as LogEntry[])
const selfEdits = atom({ plugin: 'projectadapt', key: 'selfEdits' } as const, [] as SelfEdit[])

export async function readSelfEdits($: EngineInterface): Promise<SelfEdit[]> {
  return read($, selfEdits)
}
export async function updateSelfEdits($: EngineInterface, fn: (v: SelfEdit[]) => SelfEdit[]): Promise<void> {
  await updateAtom($, selfEdits, fn)
}

export async function readProject($: EngineInterface): Promise<string> {
  return read($, project)
}
export async function updateProject($: EngineInterface, fn: (v: string) => string): Promise<void> {
  await updateAtom($, project, fn)
}
export async function readAutopilot($: EngineInterface): Promise<Autopilot | null> {
  return read($, autopilot)
}
export async function updateAutopilot($: EngineInterface, fn: (v: Autopilot | null) => Autopilot | null): Promise<void> {
  await updateAtom($, autopilot, fn)
}
export async function readLive($: EngineInterface): Promise<Live> {
  return read($, live)
}
export async function updateLive($: EngineInterface, fn: (v: Live) => Live): Promise<void> {
  await updateAtom($, live, fn)
}
export async function readAway($: EngineInterface): Promise<string[]> {
  return read($, away)
}
export async function updateAway($: EngineInterface, fn: (v: string[]) => string[]): Promise<void> {
  await updateAtom($, away, fn)
}
export async function readMeta($: EngineInterface): Promise<MetaRun | null> {
  return read($, meta)
}
export async function updateMeta($: EngineInterface, fn: (v: MetaRun | null) => MetaRun | null): Promise<void> {
  await updateAtom($, meta, fn)
}
export async function readCompose($: EngineInterface): Promise<string> {
  return read($, compose)
}
export async function updateCompose($: EngineInterface, fn: (v: string) => string): Promise<void> {
  await updateAtom($, compose, fn)
}
export async function readOrigin($: EngineInterface): Promise<'user' | 'plugin'> {
  return read($, origin)
}
export async function updateOrigin($: EngineInterface, fn: (v: 'user' | 'plugin') => 'user' | 'plugin'): Promise<void> {
  await updateAtom($, origin, fn)
}
export async function readLogQueue($: EngineInterface): Promise<LogEntry[]> {
  return read($, logQueue)
}
export async function updateLogQueue($: EngineInterface, fn: (v: LogEntry[]) => LogEntry[]): Promise<void> {
  await updateAtom($, logQueue, fn)
}

export async function get<T>($: EngineInterface, k: Key<T>): Promise<T> {
  return ((await $.store.get(k.name)) as T | undefined) ?? k.empty()
}

const locks = new Map<string, Promise<unknown>>()

// Read, change and write one key, one change at a time. A failed write (the
// store is full, say) is reported once as a toast instead of breaking the hook.
export function update<T>($: EngineInterface, k: Key<T>, fn: (value: T) => T | Promise<T>): Promise<T> {
  const run = (locks.get(k.name) ?? Promise.resolve()).then(async () => {
    const next = await fn(await get($, k))
    try {
      await $.store.set(k.name, next)
    } catch (error) {
      $.ui.toast(`ProjectAdapt: could not save ${k.name} (${error instanceof Error ? error.message.slice(0, 60) : 'storage error'})`)
    }

    return next
  })
  locks.set(k.name, run.catch(() => undefined))

  return run
}

export function set<T>($: EngineInterface, k: Key<T>, value: T): Promise<T> {
  return update($, k, () => value)
}

export function newId(prefix: string, now: number): string {
  return `${prefix}${now.toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`
}

export async function harnessOf($: EngineInterface): Promise<Harness> {
  const h = await get($, K.harness)
  if (h) return { ...h, tunables: normalizeTunables(h.tunables) }

  return update($, K.harness, async current => current ?? initialHarness(await $.clock.now())) as Promise<Harness>
}

// Brings data written by an earlier version up to this one. v1 kept per-chat
// values and a single goal in the global store; they are dropped here.
export async function migrate($: EngineInterface): Promise<void> {
  const from = await get($, K.schema)
  if (from >= SCHEMA) return
  if (from < 2) {
    for (const old of ['goal', 'autopilot', 'task-live', 'away-report', 'meta-agent', 'meta-since', 'pending']) {
      await $.store.delete(old)
    }
    await update($, K.harness, h => (h ? { ...h, tunables: normalizeTunables(h.tunables) } : h))
  }
  // v3 journals backups instead of edit text.
  if (from < 3) await $.store.delete('journal')
  await set($, K.schema, SCHEMA)
}
