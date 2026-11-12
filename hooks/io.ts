// The plugin's side effects outside the store: the project folder, the
// status line, and the meta-agent. Project-folder writes are batched: lines
// queue in session state and are written once, at the end of a turn, when
// /away stops, or on /adapt save.

import type { EngineInterface } from 'claude-code'

import type { Autopilot } from '../types'
import { get, K, readAutopilot, readLogQueue, readMeta, readProject, set, updateLogQueue, updateMeta } from './store'
import { appendLog, folderOf, lessonsFile, memoryFile, readme } from './projects'
import type { Project } from './projects'

export const META = 'projectadapt:meta'
// A meta-agent run older than this, or no longer listed, is treated as gone.
const META_STALE_MS = 30 * 60_000

export async function activeSlug($: EngineInterface): Promise<string> {
  return readProject($)
}

export async function homeDir($: EngineInterface): Promise<string> {
  return (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'
}

export async function projectFolder($: EngineInterface, slug: string): Promise<string> {
  return folderOf(await homeDir($), slug)
}

export async function activeProject($: EngineInterface): Promise<Project | undefined> {
  const slug = await activeSlug($)

  return slug ? (await get($, K.projects))[slug] : undefined
}

export async function goalOf($: EngineInterface, slug: string) {
  return slug ? (await get($, K.goals))[slug] : undefined
}

export async function queueLog($: EngineInterface, slug: string, lines: string[]): Promise<void> {
  if (!slug || lines.length === 0) return
  await updateLogQueue($, q => [...q, ...lines.map(line => ({ slug, line }))].slice(-200))
}

// Writes the queued log lines and refreshes each touched project's files.
// A failed write (a file open in another program, say) is reported, not thrown.
export async function flush($: EngineInterface, also: string[] = []): Promise<void> {
  const queued = await readLogQueue($)
  await updateLogQueue($, () => [])
  const slugs = [...new Set([...queued.map(q => q.slug), ...also])].filter(Boolean)
  if (slugs.length === 0) return
  const projects = await get($, K.projects)
  const memories = await get($, K.memories)
  const lessons = await get($, K.lessons)
  const goals = await get($, K.goals)
  const now = await $.clock.now()
  for (const slug of slugs) {
    const p = projects[slug]
    if (!p) continue
    const dir = await projectFolder($, slug)
    try {
      await $.fs.write(`${dir}/README.md`, readme(p, goals[slug]?.text, now))
      await $.fs.write(`${dir}/memory.md`, memoryFile(p, memories))
      await $.fs.write(`${dir}/lessons.md`, lessonsFile(p, lessons))
      const lines = queued.filter(q => q.slug === slug).map(q => q.line)
      if (lines.length > 0) {
        const old = (await $.fs.exists(`${dir}/log.md`)) ? String(await $.fs.read(`${dir}/log.md`)) : ''
        await $.fs.write(`${dir}/log.md`, appendLog(old, lines, now))
      }
    } catch (error) {
      $.ui.toast(`ProjectAdapt: could not update ${slug}'s files (${error instanceof Error ? error.message.slice(0, 60) : 'write error'})`)
    }
  }
}

// The one status line, built in one place from the current state.
export function statusText(project: Project | undefined, goal: { progress: string[] } | undefined, pilot: Autopilot | null): string {
  if (!project) return 'ProjectAdapt off · /activate'
  const parts = [`ProjectAdapt · ${project.name}`]
  if (goal) parts.push(`goal ${goal.progress.length}✓`)
  if (pilot) {
    const until = new Date(pilot.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    parts.push(pilot.paused ? 'away paused' : `away → ${until} (${pilot.turns}/${pilot.maxTurns})`)
  }

  return parts.join(' · ')
}

export async function refreshStatus($: EngineInterface): Promise<void> {
  const slug = await activeSlug($)
  const project = slug ? (await get($, K.projects))[slug] : undefined
  $.ui.status(statusText(project, await goalOf($, slug), await readAutopilot($)))
}

// Starts the meta-agent unless one is running. A run that is too old, or no
// longer among the session's agents, no longer blocks a new one.
export async function spawnMeta($: EngineInterface): Promise<'started' | 'running' | 'refused'> {
  const current = await readMeta($)
  const now = await $.clock.now()
  if (current) {
    const alive = (await $.agent.list()).some(a => a.id === current.id)
    if (alive && now - current.at < META_STALE_MS) return 'running'
  }
  const spawned = await $.agent.spawn({ subagentType: META, prompt: 'Review the cross-task evidence and improve the harness.', description: 'ProjectAdapt meta review' })
  if (!('agentId' in spawned) || typeof spawned.agentId !== 'string') return 'refused'
  await updateMeta($, () => ({ id: spawned.agentId as string, at: now }))
  await set($, K.metaEvidence, 0)

  return 'started'
}
