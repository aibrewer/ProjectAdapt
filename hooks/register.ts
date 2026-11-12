// Wiring: which hook runs when. The logic lives in the modules it imports.

import type { EngineInterface, Register } from 'claude-code'

import { classify } from './autonomy'
import { decide, ERROR_BACKOFF_MS, MAX_STALLS } from './autopilot'
import { installBand } from './band'
import { endTask } from './boundary'
import { addLesson, match, recordFailure, reinforce, toolWordsOf, words } from './brain'
import { installCommands, settingsOf, stopAway } from './commands'
import { activeProject, activeSlug, flush, goalOf, META, projectFolder, queueLog, refreshStatus, spawnMeta } from './io'
import { composeText, continuation, META_PROMPT, PREFIX } from './prompt'
import { backupBefore, verifySelf } from './selfcheck'
import { cap, get, harnessOf, K, migrate, readAutopilot, readAway, readCompose, readLive, readMeta, readOrigin, set, update, updateAutopilot, updateAway, updateCompose, updateLive, updateMeta, updateOrigin } from './store'
import { installTools, registerTools } from './tools'

// A failing test, build or lint run is how development works, not a mistake.
const VERIFICATION = /\b(test|tests|pytest|jest|vitest|mocha|tsc|build|lint|eslint|ruff|mypy|cargo\s+(test|check|build)|go\s+(test|build|vet)|dotnet\s+(test|build)|mvn|gradle)\b/i
// The person's next message read as a correction of the last task.
const CORRECTION = /^(no\b|nope|wrong|that'?s (not|wrong)|not what|undo|revert|didn'?t work|doesn'?t work|it'?s broken|you broke|stop\b)/i
const META_AFTER_EVIDENCE = 3

const str = (v: unknown) => (typeof v === 'string' ? v : '')

// A short, comparable description of what a tool call tried to do.
function describe(e: Record<string, unknown>): string {
  for (const k of ['command', 'file_path', 'pattern', 'url', 'query', 'path']) {
    if (typeof e[k] === 'string') return `${k}: ${(e[k] as string).slice(0, 120)}`
  }

  return ''
}

async function buildCompose($: EngineInterface): Promise<string> {
  const slug = await activeSlug($)

  return composeText({
    h: await harnessOf($),
    project: await activeProject($),
    folder: slug ? await projectFolder($, slug) : '',
    goal: await goalOf($, slug),
    pilot: await readAutopilot($),
    lessons: await get($, K.lessons),
    memories: await get($, K.memories),
    failures: await get($, K.failures),
    recommendations: await get($, K.recommendations),
    now: await $.clock.now(),
  })
}

export const register: Register = (on, options) => {
  const settings = settingsOf(options)

  on('session.start', async ($, e, next) => {
    await migrate($)
    const commands: [string, string][] = [
      ['activate', 'Turn ProjectAdapt on for a project in this chat: /activate <project or what you want done>'],
      ['away', 'Keep working while you step away: /away [time] [goal] | off | resume'],
      ['rate', 'Score the last task 1-5; this is how ProjectAdapt learns what you like'],
      ['adapt', 'ProjectAdapt status and commands: goal, reflect, lessons, save, help'],
      ['hyperfocus', 'Same as /adapt goal'],
      ['reflect', 'Same as /adapt reflect'],
      ['lessons', 'Same as /adapt lessons'],
    ]
    for (const [name, description] of commands) await $.command.register({ name, description })
    await registerTools($)
    await $.agent.register({
      name: 'meta',
      description: 'The ProjectAdapt meta-agent: reviews evidence across tasks and proposes harness improvements.',
      prompt: META_PROMPT,
      tools: [`${PREFIX}evidence`, `${PREFIX}propose`, `${PREFIX}learn`, `${PREFIX}recall`, 'Read', 'Grep', 'Glob'],
    })
    await harnessOf($)
    await refreshStatus($)

    return next(e)
  })

  // The meta-agent is the plugin's own: the model is not offered it.
  on('agent.offer', { agent: META }, () => ({ isOffered: false }))

  installTools(on)
  installCommands(on, settings)
  installBand(on)

  // Who started the turn; a person typing pauses /away; a correction marks
  // the last task.
  on('prompt.submit', async ($, e, next) => {
    if (!e.command) {
      const isPerson = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
      await updateOrigin($, () => (isPerson ? 'user' : 'plugin'))
      if (isPerson) {
        const pilot = await readAutopilot($)
        if (pilot && !pilot.paused) {
          await updateAutopilot($, a => (a ? { ...a, paused: true } : a))
          $.ui.toast('projectadapt: away paused because you typed. /away resume continues, /away off stops.')
          await refreshStatus($)
        }
        if (CORRECTION.test(e.text.trim())) {
          const now = await $.clock.now()
          await update($, K.tasks, tasks => {
            const last = tasks[tasks.length - 1]

            return last && now - last.startedAt < 3_600_000 ? [...tasks.slice(0, -1), { ...last, corrected: true }] : tasks
          })
        }
      }
    }

    return next(e)
  })

  // The ProjectAdapt section of the system prompt is built once per turn and kept,
  // so the conversation stays in the prompt cache.
  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    await updateLive($, () => ({ calls: 0, failures: 0, progressed: false, repeated: [] }))
    const text = await buildCompose($)
    await updateCompose($, () => text)
    // Recurring failures are shown once; they come back only if they recur.
    const failures = await get($, K.failures)
    if ((await activeSlug($)) && failures.some(g => g.count >= 2 && !g.isShown)) {
      await update($, K.failures, groups => groups.map(g => (g.count >= 2 ? { ...g, isShown: true } : g)))
    }

    return result
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    const text = (await readCompose($)) || (await buildCompose($))

    return { sections: [...result.sections, { id: 'projectadapt:core', text, scope: 'session' as const }] }
  })

  // Minor self-changes go through without a prompt; major ones ask. On /away
  // nothing waits: what would ask is allowed inside the envelope or refused.
  on('tool.check', async ($, e, next) => {
    const base = await next(e)
    if (base.decision === 'deny') return base
    const input = (e.input ?? {}) as Record<string, unknown>
    const tier = classify(e.tool, input, $.plugin.root)

    const pilot = await readAutopilot($)
    if (pilot && !pilot.paused && (base.decision === 'ask' || tier?.tier === 'major')) {
      const verdict = decide(e.tool, input, pilot.envelope, e.isReadOnly === true, tier?.tier)
      // Only real calls are reported; a permission query is not one.
      if (verdict.logged && e.tool_use_id) {
        const why = verdict.reason.replace(/^Autopilot: the user is away and /, '').split('. ')[0] ?? ''
        await updateAway($, away => [...away, cap(`${e.tool}: ${why}`, 200)].slice(-50))
        await queueLog($, pilot.project, [`away skipped ${e.tool}`])
      }

      return { decision: verdict.decision, reason: verdict.reason }
    }

    if (!tier) return base
    if (tier.tier === 'minor') return { decision: 'allow' as const, reason: tier.reason }

    return { decision: 'ask' as const, reason: tier.reason }
  }).catch(($, e, next) => next(e)) // on a fault, Claude Code's own rules decide

  // Every other tool: back up a file before ProjectAdapt changes itself, count the
  // call for the turn, group failures by kind, and remind the model of a
  // lesson that covers the failure right at the error.
  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const self = classify(e.tool, input, $.plugin.root)
    if (self?.tier === 'minor') {
      const file = str(input.file_path) || str(input.notebook_path)
      await backupBefore($, file, self.reason, self.kind === 'code').catch(() => undefined)
      await queueLog($, await activeSlug($), [self.reason])
    }
    const ran = await next(e)
    if (e.tool.startsWith(PREFIX) || ran.deny !== undefined || e.agentId !== undefined) return ran
    const failed = ran.isError === true
    // Compared as a string: a build may not register Bash (this one is PowerShell).
    const isVerification = failed && /^(Bash|PowerShell)$/.test(String(e.tool)) && VERIFICATION.test(str(input.command))
    await updateLive($, l => ({ ...l, calls: l.calls + 1, failures: l.failures + (failed && !isVerification ? 1 : 0) }))
    const slug = await activeSlug($)
    if (!slug) return ran
    const now = await $.clock.now()

    if (!failed) {
      const pilot = await readAutopilot($)
      const file = str(input.file_path) || str(input.notebook_path)
      if (pilot && file && /^(Edit|Write|NotebookEdit)$/.test(e.tool)) {
        await updateAutopilot($, a => (a && !a.files.includes(file) ? { ...a, files: [...a.files, file].slice(-50) } : a))
      }

      return ran
    }
    if (isVerification) return ran

    const h = await harnessOf($)
    const described = describe(input)
    const error = cap((ran.text ?? '').replace(/\s+/g, ' '), 300)
    let sig = ''
    let isNewKind = false
    await update($, K.failures, groups => {
      const r = recordFailure(groups, e.tool, described, error, now)
      sig = r.group.sig
      isNewKind = r.isNewKind

      return r.groups
    })
    await update($, K.histogram, hist => {
      const v = String(h.version)
      const row = hist[v] ?? {}
      const versions = Object.keys(hist).slice(-29)

      return { ...Object.fromEntries(versions.map(k => [k, hist[k] ?? {}])), [v]: { ...row, [sig]: (row[sig] ?? 0) + 1 } }
    })
    if (isNewKind) await update($, K.metaEvidence, x => x + 1)

    const matched = match(await get($, K.lessons), words(`${described} ${error}`), now, 3, h.tunables, toolWordsOf(e.tool))
    if (matched.length === 0) return ran
    // At most one repeat per lesson per turn.
    const live = await readLive($)
    const fresh = matched.filter(l => !live.repeated.includes(l.id)).map(l => l.id)
    if (fresh.length > 0) {
      await update($, K.lessons, lessons => reinforce(lessons, fresh, now, h.tunables))
      await updateLive($, l => ({ ...l, repeated: [...l.repeated, ...fresh] }))
    }
    const reminder = `ProjectAdapt: this looks like a mistake you have made before. Apply these lessons now:\n${matched.map(l => `- ${l.rule}`).join('\n')}`

    return { ...ran, context: [...(ran.context ?? []), reminder] }
  }).catch(($, e, next) => next(e)) // a fault here must never block a tool

  // The task boundary: record the task, judge the version under trial, ship
  // the next queued change, wake the meta-agent when there is new evidence,
  // keep /away going, and write the project files.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) {
      const meta = await readMeta($)
      if (meta && meta.id === e.agentId) {
        await updateMeta($, () => null)
        const slug = await activeSlug($)
        await queueLog($, slug, ['meta-agent finished a review'])
      }

      return result
    }
    await updateCompose($, () => '')
    const slug = await activeSlug($)
    // Self-changes made this turn are validated and tested now; a change that
    // breaks the plugin is restored from its backup.
    await verifySelf($, slug).catch(() => undefined)
    // Off means off: with no project active nothing is recorded or started.
    if (!slug) return result

    const now = await $.clock.now()
    const live = await readLive($)
    const origin = await readOrigin($)
    const h = await harnessOf($)
    if (e.answer.trim()) await queueLog($, slug, [`task (${e.reason}, ${live.calls} tool calls, ${live.failures} failed): ${e.answer.trim().slice(0, 200)}`])

    const task = origin === 'user' ? { version: h.version, startedAt: now - e.durationMs, calls: live.calls, failures: live.failures, outcome: e.reason, project: slug } : undefined
    const r = endTask(
      { h, history: await get($, K.history), queue: await get($, K.queue), ledger: await get($, K.ledger), tasks: await get($, K.tasks) },
      task,
      now,
    )
    await set($, K.harness, r.h)
    await set($, K.history, r.history)
    await set($, K.queue, r.queue)
    await set($, K.ledger, r.ledger)
    await set($, K.tasks, r.tasks)
    if (r.rolledBack) {
      const { change, why } = r.rolledBack
      await update($, K.lessons, lessons => addLesson(lessons, cap(`Harness change "${change}" made results worse; do not reintroduce it unchanged`), ['harness', 'meta'], now, r.h.tunables).lessons)
      await queueLog($, slug, [`rolled back "${change}": ${why}`])
    }
    if (r.kept) await queueLog($, slug, [`kept harness change "${r.kept}"`])
    if (r.shipped) await queueLog($, slug, [`harness v${r.h.version}: ${r.shipped}`])

    const pilot = await readAutopilot($)
    if (settings.metaEnabled && !pilot && (await get($, K.metaEvidence)) >= META_AFTER_EVIDENCE) void spawnMeta($).catch(() => undefined)

    if (pilot) {
      const goal = await goalOf($, pilot.project)
      const stalls = pilot.paused ? pilot.stalls : live.calls === 0 && !live.progressed ? pilot.stalls + 1 : 0
      const stop =
        e.reason === 'aborted' ? 'you interrupted it'
        : now > pilot.until || pilot.turns >= pilot.maxTurns ? 'its time or turn limit was reached'
        : !goal ? 'the goal is done'
        : stalls >= MAX_STALLS ? `${MAX_STALLS} turns in a row made no progress`
        : ''
      if (stop) {
        await stopAway($, pilot, stop)
      } else if (!pilot.paused && goal) {
        await updateAutopilot($, a => (a ? { ...a, turns: a.turns + 1, stalls } : a))
        const text = continuation(pilot, goal, await readAway($), stalls > 0)
        const submit = () => void $.prompt.submit({ text }).catch(() => undefined)
        // Do not wait on our own submit: it starts once this turn has ended.
        if (e.reason === 'error') $.clock.after(ERROR_BACKOFF_MS, submit)
        else submit()
      }
    }

    await flush($)
    await refreshStatus($)

    return result
  }).catch(($, e, next) => next(e))
}
