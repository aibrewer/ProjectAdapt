// The learning model: pure functions over plain data, so they can be tested
// without the engine. Everything here is stored in $.store as JSON.

export type Lesson = {
  id: string
  // One imperative sentence: what to do (or never do) next time.
  rule: string
  // Words that tie the lesson to situations: tool names, error words, topics.
  tags: string[]
  // Times the lesson was recorded or reinforced on purpose.
  hits: number
  // Times the mistake it guards against happened again anyway.
  repeats: number
  createdAt: number
  lastSeenAt: number
  // Promoted lessons are always injected, whatever their score.
  isCore: boolean
  // The project slug it was learned in; lessons apply everywhere regardless.
  project?: string
}

// Failures of one kind, grouped by signature: the tool and the shape of the
// error. A lesson is asked for only once a kind has happened more than once.
export type FailureGroup = {
  sig: string
  tool: string
  example: string
  error: string
  count: number
  firstAt: number
  lastAt: number
  // Shown to the model at the start of a turn; shown groups are not repeated.
  isShown: boolean
}

export type Memory = {
  id: string
  fact: string
  tags: string[]
  createdAt: number
  usedAt: number
  // The project slug it belongs to; absent for facts about the user at large.
  project?: string
}

export type Goal = {
  text: string
  setAt: number
  // Milestones the model reports as it works.
  progress: string[]
}

const DAY = 86_400_000

// The knobs the meta-agent may retune between tasks, only inside BOUNDS. The
// evaluator's own settings are constants in harness.ts: what is judged must
// not set how it is judged.
export type Tunables = {
  halfLifeDays: number
  repeatWeight: number
  coreAfterRepeats: number
  coreAfterHits: number
  lessonsInPrompt: number
}

export const DEFAULT_TUNABLES: Tunables = {
  halfLifeDays: 30,
  repeatWeight: 3,
  coreAfterRepeats: 2,
  coreAfterHits: 4,
  lessonsInPrompt: 12,
}

export const BOUNDS: Record<keyof Tunables, [number, number]> = {
  halfLifeDays: [7, 120],
  repeatWeight: [1, 6],
  coreAfterRepeats: [1, 5],
  coreAfterHits: [2, 10],
  lessonsInPrompt: [4, 25],
}

export function clampTune(key: string, value: number): { key: keyof Tunables; value: number } | undefined {
  if (!(key in BOUNDS) || !Number.isFinite(value)) return undefined
  const [lo, hi] = BOUNDS[key as keyof Tunables]

  return { key: key as keyof Tunables, value: Math.min(hi, Math.max(lo, value)) }
}

// Fills in knobs an older version did not have and clamps every value, so a
// stored harness can never produce NaN scores after an upgrade.
export function normalizeTunables(stored: Partial<Tunables> | undefined): Tunables {
  const out = { ...DEFAULT_TUNABLES }
  for (const k of Object.keys(DEFAULT_TUNABLES) as (keyof Tunables)[]) {
    const v = stored?.[k]
    if (typeof v === 'number') out[k] = clampTune(k, v)?.value ?? out[k]
  }

  return out
}

export const MAX_LESSONS = 300
export const MAX_MEMORIES = 500
export const MAX_FAILURE_GROUPS = 50
// Shared words, beyond tool names, before a failure counts as a lesson's.
export const MIN_MATCH = 2

const STOP = new Set(
  'the a an and or of to in on for with is are was be it this that not no at by from as into'.split(' '),
)

export function words(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9_.-]+/)
        .filter(w => w.length > 2 && !STOP.has(w)),
    ),
  ]
}

const randomId = (prefix: string, now: number) =>
  `${prefix}${now.toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`

// The formula. A lesson's weight grows with how often it mattered, grows
// fastest when the mistake recurred (a repeat means the lesson was not
// applied, so it must be louder), and fades with time since it last mattered.
//
//   score = (1 + hits + repeatWeight * repeats) * 0.5 ^ (daysSinceLastSeen / halfLifeDays)
//
// Core lessons skip the decay: they are permanent rules.
export function score(lesson: Lesson, now: number, t: Tunables = DEFAULT_TUNABLES): number {
  const base = 1 + lesson.hits + t.repeatWeight * lesson.repeats
  if (lesson.isCore) return base
  const days = Math.max(0, (now - lesson.lastSeenAt) / DAY)

  return base * Math.pow(0.5, days / t.halfLifeDays)
}

export function shouldPromote(lesson: Lesson, t: Tunables = DEFAULT_TUNABLES): boolean {
  return lesson.repeats >= t.coreAfterRepeats || lesson.hits >= t.coreAfterHits
}

export function overlap(a: string[], b: string[]): number {
  const set = new Set(a)

  return b.filter(w => set.has(w)).length
}

// Lessons relevant to a situation, best first. A tool name alone is not a
// match: a lesson must share MIN_MATCH other words with what happened.
export function match(lessons: Lesson[], situation: string[], now: number, limit = 3, t: Tunables = DEFAULT_TUNABLES, toolWords: string[] = []): Lesson[] {
  const ignore = new Set(toolWords.map(w => w.toLowerCase()))
  const meaningful = situation.filter(w => !ignore.has(w))

  return lessons
    .map(l => ({ l, o: overlap(l.tags.filter(w => !ignore.has(w)), meaningful) }))
    .filter(x => x.o >= MIN_MATCH)
    .sort((x, y) => y.o * score(y.l, now, t) - x.o * score(x.l, now, t))
    .slice(0, limit)
    .map(x => x.l)
}

export const toolWordsOf = (tool: string) => words(tool.replace(/__/g, ' ').replace(/_/g, ' ')).concat(tool.toLowerCase())

// Records a lesson, merging into an existing one when it says nearly the
// same thing, so the bank grows in weight rather than in duplicates.
export function addLesson(lessons: Lesson[], rule: string, tags: string[], now: number, t: Tunables = DEFAULT_TUNABLES, project?: string): { lessons: Lesson[]; lesson: Lesson; isNew: boolean } {
  const ruleWords = words(rule)
  const allTags = [...new Set([...tags.map(x => x.toLowerCase()), ...ruleWords])]
  const twin = lessons.find(l => {
    const shared = overlap(words(l.rule), ruleWords)

    return shared >= Math.max(3, Math.ceil(0.6 * Math.min(ruleWords.length, words(l.rule).length)))
  })
  if (twin) {
    const merged: Lesson = {
      ...twin,
      hits: twin.hits + 1,
      lastSeenAt: now,
      tags: [...new Set([...twin.tags, ...allTags])].slice(0, 40),
      // The newer wording wins when it is more specific.
      rule: rule.length > twin.rule.length ? rule : twin.rule,
    }
    merged.isCore = merged.isCore || shouldPromote(merged, t)

    return { lessons: lessons.map(l => (l.id === twin.id ? merged : l)), lesson: merged, isNew: false }
  }
  const lesson: Lesson = {
    id: randomId('L', now),
    rule,
    tags: allTags.slice(0, 40),
    hits: 1,
    repeats: 0,
    createdAt: now,
    lastSeenAt: now,
    isCore: false,
    ...(project ? { project } : {}),
  }

  return { lessons: prune([...lessons, lesson], now, t), lesson, isNew: true }
}

// A mistake that matches a lesson means the lesson was not applied: count a
// repeat, refresh it, and promote it once it keeps recurring.
export function reinforce(lessons: Lesson[], ids: string[], now: number, t: Tunables = DEFAULT_TUNABLES): Lesson[] {
  return lessons.map(l => {
    if (!ids.includes(l.id)) return l
    const next = { ...l, repeats: l.repeats + 1, lastSeenAt: now }
    next.isCore = next.isCore || shouldPromote(next, t)

    return next
  })
}

// Keeps the bank bounded: drops the weakest non-core lessons first.
export function prune(lessons: Lesson[], now: number, t: Tunables = DEFAULT_TUNABLES): Lesson[] {
  if (lessons.length <= MAX_LESSONS) return lessons
  const keep = [...lessons].sort((a, b) => score(b, now, t) - score(a, now, t)).slice(0, MAX_LESSONS)
  const ids = new Set(keep.map(l => l.id))

  return lessons.filter(l => ids.has(l.id) || l.isCore)
}

export function top(lessons: Lesson[], now: number, limit: number, t: Tunables = DEFAULT_TUNABLES): Lesson[] {
  const core = lessons.filter(l => l.isCore)
  const rest = lessons
    .filter(l => !l.isCore)
    .sort((a, b) => score(b, now, t) - score(a, now, t))
    .slice(0, Math.max(0, limit - core.length))

  return [...core, ...rest]
}

// The kind of a failure: the tool and the first words of its error, with
// numbers, paths and quoted names taken out so recurrences share it.
export function signature(tool: string, error: string): string {
  const shape = error
    .toLowerCase()
    .replace(/["'`][^"'`]*["'`]/g, ' ')
    .replace(/[a-z]:[\\/][^\s]*|\/[^\s]+/g, ' ')
    .replace(/\d+/g, ' ')
  const head = words(shape).slice(0, 6).join(' ')

  return `${tool}: ${head || 'error'}`
}

export function recordFailure(groups: FailureGroup[], tool: string, example: string, error: string, now: number): { groups: FailureGroup[]; group: FailureGroup; isNewKind: boolean } {
  const sig = signature(tool, error)
  const found = groups.find(g => g.sig === sig)
  const group: FailureGroup = found
    ? { ...found, count: found.count + 1, lastAt: now, example, error, isShown: false }
    : { sig, tool, example, error, count: 1, firstAt: now, lastAt: now, isShown: false }
  const rest = groups.filter(g => g.sig !== sig)

  return { groups: [...rest, group].sort((a, b) => b.lastAt - a.lastAt).slice(0, MAX_FAILURE_GROUPS), group, isNewKind: !found }
}

// Groups worth a lesson: the same kind of failure, more than once.
export const recurring = (groups: FailureGroup[]) => groups.filter(g => g.count >= 2)

// The groups a new lesson does not cover. It covers a group when it shares
// MIN_MATCH words, beyond the tool's name, with the group's signature.
export function uncovered(groups: FailureGroup[], lesson: Lesson): FailureGroup[] {
  return groups.filter(g => overlap(lesson.tags, words(`${g.sig} ${g.error}`).filter(w => !toolWordsOf(g.tool).includes(w))) < MIN_MATCH)
}

// Searches the bank; the active project's facts rank ahead of others.
export function recall(memories: Memory[], query: string, limit = 8, project?: string): Memory[] {
  const q = words(query)
  const boost = (m: Memory) => (project && m.project === project ? 2 : 0)
  if (q.length === 0) return [...memories].sort((a, b) => boost(b) - boost(a) || b.usedAt - a.usedAt).slice(0, limit)

  return memories
    .map(m => ({ m, o: overlap([...m.tags, ...words(m.fact)], q) }))
    .filter(x => x.o > 0)
    .sort((x, y) => y.o + boost(y.m) - (x.o + boost(x.m)) || y.m.usedAt - x.m.usedAt)
    .slice(0, limit)
    .map(x => x.m)
}

export function addMemory(memories: Memory[], fact: string, tags: string[], now: number, project?: string): Memory[] {
  const twin = memories.find(m => m.fact.trim().toLowerCase() === fact.trim().toLowerCase() && m.project === project)
  if (twin) return memories.map(m => (m === twin ? { ...m, usedAt: now } : m))
  const memory: Memory = {
    id: randomId('M', now),
    fact,
    tags: [...new Set([...tags.map(t => t.toLowerCase()), ...words(fact)])].slice(0, 30),
    createdAt: now,
    usedAt: now,
    ...(project ? { project } : {}),
  }
  const all = [...memories, memory]

  return all.length > MAX_MEMORIES ? all.sort((a, b) => b.usedAt - a.usedAt).slice(0, MAX_MEMORIES) : all
}
