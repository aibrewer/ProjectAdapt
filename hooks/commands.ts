// The person's commands. Top level: /activate, /away, /rate. Everything else
// lives under /adapt; the older names (/hyperfocus, /reflect, /lessons) stay
// as aliases.

import type { EngineInterface, On, PluginOptions } from 'claude-code'

import type { Autopilot } from '../types'
import { DEFAULT_HOURS, DEFAULT_MAX_TURNS, isHomeLike, workFolder } from './autopilot'
import { addLesson, score } from './brain'
import { meanReward, MAX_HISTORY } from './harness'
import { activeSlug, flush, goalOf, homeDir, projectFolder, queueLog, refreshStatus, spawnMeta } from './io'
import { awayReport, awaySummaryLine, redact, slugify } from './projects'
import type { Project } from './projects'
import { continuation, REFLECT } from './prompt'
import { restore } from './selfcheck'
import { cap, get, harnessOf, K, readAutopilot, readAway, set, update, updateAutopilot, updateAway, updateProject } from './store'

export type Settings = { metaEnabled: boolean; awayMaxHours: number; awayMaxTurns: number }

export function settingsOf(options: PluginOptions): Settings {
  const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d)

  return {
    metaEnabled: options.metaEnabled !== false,
    awayMaxHours: num(options.awayMaxHours, 24, 1, 72),
    awayMaxTurns: num(options.awayMaxTurns, DEFAULT_MAX_TURNS, 10, 1000),
  }
}

const USAGE = `ProjectAdapt commands
  /activate <project>       turn ProjectAdapt on for a project in this chat
  /away [time] [goal]       keep working while you step away (e.g. /away 2h, /away 30m finish the report)
  /away off | resume        stop, or continue after it paused
  /rate <1-5> [note]        score the last task; this is how ProjectAdapt learns what you like
  /adapt                    status
  /adapt  goal [text|clear] show, set or clear the project goal
  /adapt  reflect           review this chat and turn it into lessons
  /adapt  lessons           what it has learned
  /adapt  save              save everything to the project folder
  /adapt  help              this list
Advanced: /adapt harness | meta | changes | undo | rollback | forget <id> | reset`

// Parses 30m, 1.5h, 2h or a bare number of hours.
export function parseDuration(token: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)(m|min|h|hr|hours?)?$/i.exec(token)
  if (!m) return undefined
  const n = Number(m[1])

  return /^m/i.test(m[2] ?? '') ? n / 60 : n
}

async function activate($: EngineInterface, args: string): Promise<{ project: Project; isNew: boolean; envelope: string; homeLike: boolean }> {
  const cwd = await $.session.cwd()
  const name = cap(args.trim() || cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'project', 80)
  const slug = slugify(name)
  const now = await $.clock.now()
  let isNew = false
  let project: Project | undefined
  await update($, K.projects, projects => {
    const known = projects[slug]
    isNew = !known
    project = known ? { ...known, activations: known.activations + 1, cwd } : { slug, name, cwd, createdAt: now, activations: 1 }

    return { ...projects, [slug]: project }
  })
  await updateProject($, () => slug)
  const home = await homeDir($)
  const homeLike = isHomeLike(cwd, home)
  const envelope = homeLike ? workFolder(home, slug) : cwd
  await queueLog($, slug, [`activated in ${cwd}`])
  await flush($, [slug])
  await refreshStatus($)

  return { project: project as Project, isNew, envelope, homeLike }
}

// Ends an /away run: writes the welcome-back report, shows it, notifies.
export async function stopAway($: EngineInterface, pilot: Autopilot, why: string): Promise<void> {
  await updateAutopilot($, () => null)
  const needsYou = await readAway($)
  await updateAway($, () => [])
  const slug = pilot.project
  const now = await $.clock.now()
  const goal = await goalOf($, slug)
  const finished = goal ? undefined : (await get($, K.goalsDone)).slice(-1)[0]
  const done = (goal ?? finished)?.progress.slice(pilot.milestonesAtStart) ?? []
  const assumptions = (await get($, K.memories)).filter(m => m.project === slug && m.createdAt >= pilot.startedAt).map(m => m.fact)
  const dir = await projectFolder($, slug)
  const project = (await get($, K.projects))[slug]
  const summary = {
    name: project?.name ?? slug,
    startedAt: pilot.startedAt,
    endedAt: now,
    turns: pilot.turns,
    stop: why,
    done,
    assumptions,
    needsYou,
    files: pilot.files,
    logPath: `${dir}/log.md`,
  }
  try {
    await $.fs.write(`${dir}/away-report.md`, awayReport(summary))
  } catch {
    $.ui.toast('projectadapt: could not write away-report.md')
  }
  await queueLog($, slug, [`away stopped after ${pilot.turns} turns: ${why}`, ...needsYou.map(n => `needs you: ${n}`)])
  await flush($)
  $.ui.log(`${awaySummaryLine(summary)}\nReport: ${dir}/away-report.md`)
  $.ui.toast(`ProjectAdapt: away stopped (${why})`)
  await $.ui.notify(`${awaySummaryLine(summary)} Report: ${dir}/away-report.md`, { title: 'ProjectAdapt' })
  await refreshStatus($)
}

export function installCommands(on: On, settings: Settings): void {
  on('command.run', { command: 'activate' }, async ($, e) => {
    const { project, isNew, envelope, homeLike } = await activate($, e.args)
    const folder = await projectFolder($, project.slug)
    const where = homeLike ? ` This chat runs in your home folder, so on /away changes are limited to ${envelope}.` : ''
    void $.prompt.submit({
      text: isNew
        ? `ProjectAdapt is now active for a new project: "${project.name}". 1) Look at the working folder and anything the description implies to understand the project. 2) Set the goal with mcp__projectadapt__progress (pass goal); if it is unclear, set the most likely goal and say so in one line. 3) Save the key facts with mcp__projectadapt__remember. 4) Start on the first step.`
        : `ProjectAdapt is active again for project "${project.name}". Read the project memory and log in ${folder}, recall where things stand, then decide the most useful next step toward the goal and do it.`,
    }).catch(() => undefined)

    return { text: `ProjectAdapt activated for "${project.name}". Project folder: ${folder}.${where}` }
  })

  on('command.run', { command: 'away' }, async ($, e) => {
    const [first = '', ...rest] = e.args.trim().split(/\s+/)
    const verb = first.toLowerCase()
    const pilot = await readAutopilot($)

    if (verb === 'off' || verb === 'stop') {
      if (!pilot) return { text: 'Away mode is not running.' }
      await stopAway($, pilot, 'you turned it off')

      return { text: 'Away mode off.' }
    }
    if (verb === 'resume') {
      if (!pilot) return { text: 'Away mode is not running. Start it with /away [time] [goal].' }
      const goal = await goalOf($, pilot.project)
      if (!goal) return { text: 'There is no goal to resume. Start again with /away [time] <goal>.' }
      await updateAutopilot($, a => (a ? { ...a, paused: false, stalls: 0 } : a))
      await refreshStatus($)
      void $.prompt.submit({ text: continuation(pilot, goal, await readAway($), false) }).catch(() => undefined)

      return { text: 'Away mode resumed.' }
    }

    const hours = parseDuration(verb)
    const goalText = cap((hours === undefined ? [first, ...rest] : rest).join(' ').trim())
    const h = hours ?? DEFAULT_HOURS
    if (!(h > 0) || h > settings.awayMaxHours) return { text: `Usage: /away [time up to ${settings.awayMaxHours}h, e.g. 30m or 2h] [goal]` }

    // One input: activate from the folder when this chat is not active yet.
    let slug = await activeSlug($)
    let homeNote = ''
    if (!slug) {
      const a = await activate($, '')
      slug = a.project.slug
    }
    const cwd = await $.session.cwd()
    const home = await homeDir($)
    const envelope = isHomeLike(cwd, home) ? workFolder(home, slug) : cwd
    if (envelope !== cwd) homeNote = ` Working from your home folder, so changes are limited to ${envelope}.`

    const now = await $.clock.now()
    if (goalText) await update($, K.goals, goals => ({ ...goals, [slug]: { text: goalText, setAt: now, progress: [] } }))
    let goal = await goalOf($, slug)
    if (!goal) {
      const name = (await get($, K.projects))[slug]?.name ?? slug
      goal = { text: `Make the most useful progress on ${name}`, setAt: now, progress: [] }
      await update($, K.goals, goals => ({ ...goals, [slug]: goal as NonNullable<typeof goal> }))
    }
    const next: Autopilot = {
      project: slug,
      startedAt: now,
      until: now + h * 3_600_000,
      maxTurns: settings.awayMaxTurns,
      turns: 0,
      stalls: 0,
      paused: false,
      envelope,
      files: [],
      milestonesAtStart: goal.progress.length,
    }
    await updateAutopilot($, () => next)
    await updateAway($, () => [])
    await queueLog($, slug, [`away on for ${h}h, goal: ${goal.text}`])
    await refreshStatus($)
    void $.prompt.submit({ text: `${continuation(next, goal, [], false)}\nThe user has stepped away for ${h} hours; work without stopping.` }).catch(() => undefined)
    const until = new Date(next.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

    return { text: `Away until ${until} on: ${goal.text}.${homeNote} It won't wait for you; anything risky is skipped and listed in away-report.md. Typing pauses it; Esc stops it.` }
  })

  on('command.run', { command: 'rate' }, async ($, e) => {
    const [n, ...note] = e.args.trim().split(/\s+/)
    const rating = Number(n)
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { text: 'Usage: /rate <1-5> [what was good or bad]' }
    const tasks = await get($, K.tasks)
    if (tasks.length === 0) return { text: 'No finished task to rate yet.' }
    await update($, K.tasks, all => (all.length ? [...all.slice(0, -1), { ...(all[all.length - 1] as (typeof all)[number]), rating }] : all))
    await update($, K.metaEvidence, x => x + 1)
    if (note.length > 0 && rating <= 2) {
      const h = await harnessOf($)
      const now = await $.clock.now()
      const slug = await activeSlug($)
      await update($, K.lessons, lessons => addLesson(lessons, cap(`User feedback on a weak result: ${note.join(' ')}`), ['feedback'], now, h.tunables, slug || undefined).lessons)
    }

    return { text: `Rated the last task ${rating}/5. Ratings steer which improvements ProjectAdapt keeps.` }
  })

  on('command.run', { command: 'hyperfocus' }, ($, e) => goalCommand($, e.args))
  on('command.run', { command: 'reflect' }, $ => reflectCommand($))
  on('command.run', { command: 'lessons' }, $ => lessonsCommand($))

  on('command.run', { command: 'adapt' }, async ($, e) => {
    const [verb = '', ...args] = e.args.trim().split(/\s+/)
    const arg = args.join(' ')
    const h = await harnessOf($)
    const history = await get($, K.history)
    const slug = await activeSlug($)

    switch (verb.toLowerCase()) {
      case 'goal':
        return goalCommand($, arg)
      case 'reflect':
        return reflectCommand($)
      case 'lessons':
        return lessonsCommand($)
      case 'help':
        return { text: USAGE }
      case 'save': {
        if (!slug) return { text: 'Activate a project first: /activate <project>.' }
        const dir = await saveSnapshot($, slug)

        return { text: `Saved everything to ${dir} (snapshot.json plus README, memory, lessons and log).` }
      }
      case 'harness': {
        const ledger = await get($, K.ledger)

        return {
          text: `Version ${h.version} (${h.note})\nPlaybook:\n${h.playbook.map(r => `  - ${r}`).join('\n') || '  (empty)'}\nSettings: ${JSON.stringify(h.tunables)}\nChanges:\n${ledger.slice(-8).map(l => `  v${l.version} ${l.status}: ${l.change}`).join('\n') || '  (none yet)'}`,
        }
      }
      case 'meta': {
        const r = await spawnMeta($)

        return { text: r === 'started' ? 'Meta-agent started in the background.' : r === 'running' ? 'The meta-agent is already running.' : 'The meta-agent could not be started.' }
      }
      case 'changes': {
        const journal = await get($, K.journal)

        return { text: journal.slice(-15).map(c => `${new Date(c.at).toLocaleString()}  ${c.reason}  (${c.file})`).join('\n') || 'No self-changes yet.' }
      }
      case 'undo': {
        const journal = await get($, K.journal)
        const last = journal[journal.length - 1]
        if (!last) return { text: 'Nothing to undo.' }
        await restore($, last)
        await update($, K.journal, j => j.slice(0, -1))

        return { text: `Undid "${last.reason}" in ${last.file}.` }
      }
      case 'rollback': {
        const prev = history[history.length - 1]
        if (!prev) return { text: 'No earlier version to go back to.' }
        await set($, K.harness, { ...prev, version: h.version + 1, note: `manual rollback to v${prev.version}`, at: await $.clock.now() })
        await update($, K.history, hs => [...hs, h].slice(-MAX_HISTORY))

        return { text: `Went back to version ${prev.version}'s settings (now version ${h.version + 1}).` }
      }
      case 'forget': {
        if (!arg) return { text: 'Usage: /adapt forget <id> (ids are shown by /adapt lessons and in memory.md)' }
        const lesson = (await get($, K.lessons)).find(l => l.id === arg)
        const memory = (await get($, K.memories)).find(m => m.id === arg)
        if (!lesson && !memory) return { text: `No lesson or memory with id ${arg}.` }
        if (lesson) await update($, K.lessons, ls => ls.filter(l => l.id !== arg))
        if (memory) await update($, K.memories, ms => ms.filter(m => m.id !== arg))
        await flush($, slug ? [slug] : [])

        return { text: lesson ? `Forgot lesson ${arg}: ${lesson.rule}` : `Forgot memory ${arg}: ${memory?.fact}` }
      }
      case 'reset':
        return resetCommand($, args)
      case '':
      case 'status':
        return { text: await statusReport($) }
      default:
        return { text: `Unknown command "${verb}".\n\n${USAGE}` }
    }
  })
}

async function goalCommand($: EngineInterface, args: string) {
  const slug = await activeSlug($)
  if (!slug) return { text: 'Activate a project first: /activate <project>.' }
  const text = args.trim()
  const goal = await goalOf($, slug)
  if (!text) {
    if (!goal) return { text: 'No goal yet. Set one with /adapt goal <what you want done>.' }

    return { text: `Goal: ${goal.text}\n${goal.progress.length ? goal.progress.map(p => `  ✓ ${p}`).join('\n') : '  (no milestones yet)'}` }
  }
  if (text === 'clear') {
    await update($, K.goals, goals => {
      const rest = { ...goals }
      delete rest[slug]

      return rest
    })
    await refreshStatus($)

    return { text: 'Goal cleared.' }
  }
  const now = await $.clock.now()
  await update($, K.goals, goals => ({ ...goals, [slug]: { text: cap(text), setAt: now, progress: [] } }))
  await queueLog($, slug, [`goal set: ${text}`])
  await refreshStatus($)
  void $.prompt.submit({ text: `New goal set: ${text}\nStart now: state the first milestone, check the relevant lessons, and begin.` }).catch(() => undefined)

  return { text: `Goal set: ${text}` }
}

async function reflectCommand($: EngineInterface) {
  void $.prompt.submit({ text: REFLECT }).catch(() => undefined)

  return { text: 'Reflection started.' }
}

async function lessonsCommand($: EngineInterface) {
  const now = await $.clock.now()
  const t = (await harnessOf($)).tunables
  const lessons = [...(await get($, K.lessons))].sort((a, b) => score(b, now, t) - score(a, now, t))
  if (lessons.length === 0) return { text: 'No lessons yet. They are recorded as Claude fixes recurring mistakes, or with /adapt reflect.' }

  return { text: lessons.slice(0, 40).map(l => `${l.id}  ${score(l, now, t).toFixed(1).padStart(5)}  ${l.isCore ? 'permanent' : '         '}  ${l.rule}`).join('\n') }
}

// Saves a full snapshot to the project folder. Recurring-failure details and
// the self-change journal (raw tool output and code) are left out, and the
// rest is passed through secret redaction.
async function saveSnapshot($: EngineInterface, slug: string): Promise<string> {
  const all: Record<string, unknown> = {}
  for (const k of await $.store.keys()) {
    if (k === K.failures.name || k === K.journal.name) continue
    all[k] = await $.store.get(k)
  }
  const dir = await projectFolder($, slug)
  await $.fs.write(`${dir}/snapshot.json`, redact(JSON.stringify({ savedAt: new Date(await $.clock.now()).toISOString(), store: all }, null, 2)))
  await queueLog($, slug, ['saved a full snapshot'])
  await flush($, [slug])

  return dir
}

async function resetCommand($: EngineInterface, args: string[]) {
  const scopeProject = args.includes('project')
  const confirmed = args.includes('confirm')
  const slug = await activeSlug($)
  const lessons = await get($, K.lessons)
  const memories = await get($, K.memories)
  const projects = await get($, K.projects)
  if (scopeProject && !slug) return { text: 'Activate the project to reset first: /activate <project>.' }
  if (!confirmed) {
    const what = scopeProject
      ? `${lessons.filter(l => l.project === slug).length} lessons, ${memories.filter(m => m.project === slug).length} memories and the goal of "${slug}"`
      : `${lessons.length} lessons, ${memories.length} memories, ${Object.keys(projects).length} projects and all of ProjectAdapt's history`
    const how = scopeProject ? '/adapt reset project confirm' : '/adapt reset confirm'

    return { text: `This deletes ${what}. A snapshot is saved first and project folders are kept.\nTo go ahead: ${how}` }
  }
  if (slug) await saveSnapshot($, slug)
  if (scopeProject) {
    await update($, K.lessons, ls => ls.filter(l => l.project !== slug))
    await update($, K.memories, ms => ms.filter(m => m.project !== slug))
    await update($, K.goals, goals => {
      const rest = { ...goals }
      delete rest[slug]

      return rest
    })
    await flush($, [slug])

    return { text: `Reset "${slug}". The snapshot is in its project folder.` }
  }
  for (const k of await $.store.keys()) await $.store.delete(k)
  await updateProject($, () => '')
  await updateAutopilot($, () => null)
  await refreshStatus($)

  return { text: `ProjectAdapt was reset.${slug ? ' A snapshot was saved in the project folder first.' : ''} Run /activate to start again.` }
}

async function statusReport($: EngineInterface): Promise<string> {
  const slug = await activeSlug($)
  const project = slug ? (await get($, K.projects))[slug] : undefined
  const goal = await goalOf($, slug)
  const pilot = await readAutopilot($)
  const lessons = await get($, K.lessons)
  const memories = await get($, K.memories)
  const h = await harnessOf($)
  const r = meanReward(await get($, K.tasks), h.version)
  const queued = (await get($, K.queue)).length
  const away = !pilot
    ? 'off'
    : pilot.paused
      ? 'paused (you typed). /away resume to continue'
      : `on until ${new Date(pilot.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} (turn ${pilot.turns}/${pilot.maxTurns})`

  return [
    `Project    ${project ? `${project.name}  (${await projectFolder($, project.slug)})` : 'not active in this chat. /activate <project>'}`,
    `Goal       ${goal ? `${goal.text} · ${goal.progress.length} milestones done` : '(none)'}`,
    `Away       ${away}`,
    `Learned    ${lessons.length} lessons (${lessons.filter(l => l.isCore).length} permanent) · ${memories.filter(m => !slug || m.project === slug).length} facts saved${slug ? ' for this project' : ''}`,
    `Improving  version ${h.version} · ${r.n ? `score ${r.mean.toFixed(2)} over ${r.n} tasks` : 'no scored tasks yet'}${queued ? ` · ${queued} change(s) waiting` : ''}`,
    '',
    'Commands   /away · /rate · /adapt goal | reflect | lessons | save | help',
  ].join('\n')
}
