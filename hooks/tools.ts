// The tools the model calls: learn, remember, recall, progress for the main
// agent; evidence and propose for the meta-agent (kept behind ToolSearch so
// they stay out of the main agent's prompt).

import type { EngineInterface, On } from 'claude-code'

import { addLesson, addMemory, BOUNDS, match, recall, recurring, score, top, uncovered, words } from './brain'
import { evidence } from './harness'
import type { Proposal } from './harness'
import { activeSlug, queueLog, refreshStatus } from './io'
import { PREFIX } from './prompt'
import { cap, get, harnessOf, K, update, updateLive } from './store'

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(x => cap(x, 60)).slice(0, 12) : [])
const input = (e: unknown) => e as Record<string, unknown>

export async function registerTools($: EngineInterface): Promise<void> {
  const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = [], isDeferred = false) =>
    $.tool.register({ name, description, inputSchema: { type: 'object', properties, required }, isDeferred })
  const strings = { type: 'array', items: { type: 'string' } }
  await tool('learn', 'Record a lesson so a recurring mistake is not repeated. rule: one imperative sentence (what to do next time). tags: error words, topics. Near-duplicates merge and gain weight.', { rule: { type: 'string' }, tags: strings }, ['rule'])
  await tool('remember', 'Save a durable fact to the project memory (decisions, locations, deadlines, results, assumptions). Never secrets.', { fact: { type: 'string' }, tags: strings }, ['fact'])
  await tool('recall', 'Search the project memory and lessons. Empty query returns the most recent memories.', { query: { type: 'string' } })
  await tool('progress', 'Report progress on the project goal. goal: set or replace the goal. milestone: a step reached. done: true when the goal is complete.', { goal: { type: 'string' }, milestone: { type: 'string' }, done: { type: 'boolean' } })
  await tool('evidence', 'For the ProjectAdapt meta-agent: cross-task evidence for improving the harness.', {}, [], true)
  await tool(
    'propose',
    'For the ProjectAdapt meta-agent: queue one harness change. kind: playbook-add | playbook-remove | tune | recommend. text for playbook and recommend; key and value for tune; reason always.',
    {
      kind: { type: 'string', enum: ['playbook-add', 'playbook-remove', 'tune', 'recommend'] },
      text: { type: 'string' },
      key: { type: 'string', enum: Object.keys(BOUNDS) },
      value: { type: 'number' },
      reason: { type: 'string' },
    },
    ['kind', 'reason'],
    true,
  )
}

export function installTools(on: On): void {
  on('tool.call', { tool: `${PREFIX}learn` }, async ($, e) => {
    const rule = cap(str(input(e).rule).trim())
    if (!rule) return { deny: 'rule is required' }
    const h = await harnessOf($)
    const slug = await activeSlug($)
    const now = await $.clock.now()
    let added: ReturnType<typeof addLesson> | undefined
    await update($, K.lessons, lessons => {
      added = addLesson(lessons, rule, list(input(e).tags), now, h.tunables, slug || undefined)

      return added.lessons
    })
    if (!added) return { deny: 'could not record the lesson' }
    const { lesson, isNew } = added
    // The failures this lesson covers no longer need one.
    await update($, K.failures, groups => uncovered(groups, lesson))
    const result = `${isNew ? 'Learned' : 'Reinforced'} ${lesson.id}${lesson.isCore ? ' [core]' : ''}: ${lesson.rule}`
    await queueLog($, slug, [result])

    return { result }
  })

  on('tool.call', { tool: `${PREFIX}remember` }, async ($, e) => {
    const fact = cap(str(input(e).fact).trim())
    if (!fact) return { deny: 'fact is required' }
    const slug = await activeSlug($)
    const now = await $.clock.now()
    await update($, K.memories, memories => addMemory(memories, fact, list(input(e).tags), now, slug || undefined))
    await queueLog($, slug, [`remembered: ${fact}`])

    return { result: `Remembered${slug ? ` for ${slug}` : ''}: ${fact}` }
  })

  on('tool.call', { tool: `${PREFIX}recall` }, async ($, e) => {
    const query = str(input(e).query)
    const now = await $.clock.now()
    const slug = await activeSlug($)
    let found: ReturnType<typeof recall> = []
    // Only usedAt changes, inside the lock, so a remember made at the same
    // moment is never overwritten.
    await update($, K.memories, memories => {
      found = recall(memories, query, 8, slug || undefined)
      const ids = new Set(found.map(m => m.id))

      return memories.map(m => (ids.has(m.id) ? { ...m, usedAt: now } : m))
    })
    const lessons = match(await get($, K.lessons), words(query), now, 5)
    const out = [
      found.length ? `Memories:\n${found.map(m => `- ${m.fact}`).join('\n')}` : 'No matching memories.',
      lessons.length ? `Lessons:\n${lessons.map(l => `- ${l.rule}`).join('\n')}` : '',
    ]

    return { result: out.filter(Boolean).join('\n\n') }
  })

  on('tool.call', { tool: `${PREFIX}progress` }, async ($, e) => {
    const slug = await activeSlug($)
    if (!slug) return { result: 'ProjectAdapt is not active in this chat; nothing recorded.' }
    const newGoal = cap(str(input(e).goal).trim())
    const milestone = cap(str(input(e).milestone).trim())
    const now = await $.clock.now()
    await updateLive($, live => ({ ...live, progressed: true }))
    let reply = ''
    await update($, K.goals, goals => {
      const goal = goals[slug]
      if (newGoal) {
        reply = `Goal set: ${newGoal}`

        return { ...goals, [slug]: { text: newGoal, setAt: now, progress: milestone ? [milestone] : [] } }
      }
      if (!goal) {
        reply = 'No goal yet; pass goal to set one.'

        return goals
      }
      if (input(e).done === true) {
        reply = 'Goal marked complete. Run a short reflection and record lessons from it.'
        const rest = { ...goals }
        delete rest[slug]
        void update($, K.goalsDone, done => [...done, { ...goal, progress: [...goal.progress, milestone].filter(Boolean) }].slice(-20))

        return rest
      }
      reply = milestone ? `Progress recorded: ${milestone}` : 'Nothing to record.'

      return milestone ? { ...goals, [slug]: { ...goal, progress: [...goal.progress, milestone].slice(-30) } } : goals
    })
    await queueLog($, slug, [newGoal ? `goal set: ${newGoal}` : input(e).done === true ? `GOAL COMPLETE: ${milestone}` : `milestone: ${milestone}`])
    if (input(e).done === true) $.ui.toast('projectadapt: goal complete')
    await refreshStatus($)

    return { result: reply }
  })

  on('tool.call', { tool: `${PREFIX}evidence` }, async $ => {
    const now = await $.clock.now()
    const h = await harnessOf($)
    const lessons = await get($, K.lessons)
    const groups = await get($, K.failures)
    const histogram = (await get($, K.histogram))[String(h.version)] ?? {}
    const extra = [
      `Top lessons (score, repeats):\n${top(lessons, now, 15, h.tunables).map(l => `- ${score(l, now, h.tunables).toFixed(1)} r${l.repeats}${l.isCore ? ' core' : ''}: ${l.rule}`).join('\n') || '(none)'}`,
      `Failure kinds this version (count): ${Object.entries(histogram).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([s, n]) => `${s} ×${n}`).join('; ') || '(none)'}`,
      `Recurring failures:\n${recurring(groups).slice(0, 8).map(g => `- ${g.sig} ×${g.count}: ${g.error.slice(0, 160)}`).join('\n') || '(none)'}`,
      `Queued proposals: ${(await get($, K.queue)).length}`,
      `Plugin folder (read it for code recommendations): ${$.plugin.root}`,
    ].join('\n\n')

    return { result: evidence(h, await get($, K.history), await get($, K.tasks), await get($, K.ledger), extra) }
  })

  on('tool.call', { tool: `${PREFIX}propose` }, async ($, e) => {
    const kind = str(input(e).kind)
    const reason = cap(str(input(e).reason).trim() || 'no reason given', 200)
    const text = cap(str(input(e).text).trim(), 300)
    if (kind === 'recommend') {
      if (!text) return { deny: 'text is required' }
      await update($, K.recommendations, recs => [...recs.filter(r => !r.startsWith(text)), `${text} (why: ${reason})`].slice(-6))

      return { result: 'Recommendation queued for the main agent.' }
    }
    let p: Proposal
    if (kind === 'playbook-add' || kind === 'playbook-remove') {
      if (!text) return { deny: 'text is required' }
      p = { kind, text, reason }
    } else if (kind === 'tune') {
      if (typeof input(e).value !== 'number') return { deny: 'value must be a number' }
      p = { kind, key: str(input(e).key), value: input(e).value as number, reason }
    } else {
      return { deny: `unknown kind ${kind}` }
    }
    await update($, K.queue, queue => [...queue, p].slice(-5))

    return { result: 'Queued. Changes ship one at a time, each after the previous one has been judged over 10 tasks.' }
  })
}
