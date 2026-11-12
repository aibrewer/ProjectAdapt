// One folder per project under ~/.claude/projectadapt/projects/<slug>/, written in
// plain Markdown so the person can open it and see what Claude keeps:
//   README.md     what the project is, when it was activated, its goal
//   memory.md     the facts saved for the project
//   lessons.md    lessons recorded while working on it
//   log.md        a running log: activations, milestones, task results,
//                 assumptions made on autopilot, actions it refused
//   snapshot.json everything the plugin holds, from /adapt save

import type { Lesson, Memory } from './brain'

export type Project = {
  slug: string
  name: string
  cwd: string
  createdAt: number
  activations: number
}

export const MAX_LOG_LINES = 600

// Takes out what looks like a secret before anything reaches a file the person
// may open or share: API keys and tokens, bearer and basic auth, passwords in
// URLs and key=value pairs, private keys, connection strings.
const SECRETS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[private key]'],
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '[key]'],
  [/\b(ghp|gho|ghu|ghs|github_pat|xox[abpr]|glpat)[-_][A-Za-z0-9_-]{10,}/g, '[token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[aws key]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[key]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[jwt]'],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [redacted]'],
  [/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)(["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi, '$1$2[redacted]'],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+):[^@\s/]+@/gi, '$1:[redacted]@'],
]

export function redact(text: string): string {
  return SECRETS.reduce((t, [re, to]) => t.replace(re, to), text)
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'project'
  )
}

export function folderOf(home: string, slug: string): string {
  return `${home.replace(/\\/g, '/').replace(/\/$/, '')}/.claude/projectadapt/projects/${slug}`
}

const stamp = (at: number) => new Date(at).toISOString().replace('T', ' ').slice(0, 16)

export function readme(p: Project, goal: string | undefined, now: number): string {
  return [
    `# ${p.name}`,
    '',
    `- Folder Claude works in: \`${p.cwd}\``,
    `- First activated: ${stamp(p.createdAt)}`,
    `- Activations: ${p.activations} (last ${stamp(now)})`,
    `- Current goal: ${goal ?? '(none)'}`,
    '',
    'Files here: memory.md (facts), lessons.md (what was learned), log.md (what happened), snapshot.json (full backup from /adapt save).',
    '',
  ].join('\n')
}

export function memoryFile(p: Project, memories: Memory[]): string {
  const own = memories.filter(m => m.project === p.slug).sort((a, b) => a.createdAt - b.createdAt)

  return redact(`# Memory: ${p.name}\n\n${own.map(m => `- ${m.fact}  _(${stamp(m.createdAt)}, ${m.id})_`).join('\n') || '_Nothing saved yet._'}\n`)
}

export function lessonsFile(p: Project, lessons: Lesson[]): string {
  const own = lessons.filter(l => l.project === p.slug)

  return redact(`# Lessons: ${p.name}\n\n${own.map(l => `- ${l.isCore ? '**[core]** ' : ''}${l.rule}  _(${l.id}, hits ${l.hits}, repeats ${l.repeats})_`).join('\n') || '_None yet._'}\n`)
}

export type AwaySummary = {
  name: string
  startedAt: number
  endedAt: number
  turns: number
  stop: string
  done: string[]
  assumptions: string[]
  needsYou: string[]
  files: string[]
  logPath: string
}

// The welcome-back report: what happened while the person was away, in the
// order they need it.
export function awayReport(a: AwaySummary): string {
  const list = (items: string[], empty: string) => (items.length ? items.map(i => `- ${i}`).join('\n') : `_${empty}_`)
  const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

  return redact(
    [
      `# While you were away: ${a.name}`,
      '',
      `${time(a.startedAt)} to ${time(a.endedAt)} · ${a.turns} turns · stopped because ${a.stop}`,
      '',
      `## Needs you (${a.needsYou.length})`,
      list(a.needsYou, 'Nothing.'),
      '',
      '## Done',
      list(a.done, 'No milestones reported.'),
      '',
      '## Assumptions made',
      list(a.assumptions, 'None recorded.'),
      '',
      '## Files changed',
      list(a.files, 'None.'),
      '',
      `Full log: ${a.logPath}`,
      '',
    ].join('\n'),
  )
}

export const awaySummaryLine = (a: AwaySummary) =>
  `Away ${a.turns} turns, stopped: ${a.stop}. Done ${a.done.length} · needs you ${a.needsYou.length} · files ${a.files.length}.`

export function appendLog(existing: string, lines: string[], now: number): string {
  const head = existing.trim() ? existing.trimEnd().split('\n') : ['# Log', '']
  const all = [...head, ...lines.map(l => `- ${stamp(now)}  ${redact(l).replace(/\s+/g, ' ').slice(0, 400)}`)]

  return (all.length > MAX_LOG_LINES ? ['# Log (older entries trimmed)', '', ...all.slice(-MAX_LOG_LINES)] : all).join('\n') + '\n'
}
