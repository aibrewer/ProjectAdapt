// Everything ProjectAdapt says to the model. The system-prompt section is built
// once at the start of each turn and kept as is until the turn ends, so the
// conversation stays in the prompt cache; what changes mid-turn reaches the
// model through tool-result context instead.

import type { Autopilot } from '../types'
import { recurring, top } from './brain'
import type { FailureGroup, Goal, Lesson, Memory } from './brain'
import type { Harness } from './harness'
import type { Project } from './projects'

export const PREFIX = 'mcp__projectadapt__'
const MEMORIES_IN_PROMPT = 8

export const INACTIVE = 'ProjectAdapt (self-improving assistant) is installed but not active in this chat. If the user wants it, they run /activate <project>.'

const ACTIVE = (name: string, folder: string) => `# ProjectAdapt is active for project "${name}"
The user activated you once for this project and expects you to drive it with as little input from them as possible.
- Skills: when a task clearly matches one of your available skills (documents, spreadsheets, data, design, browser, review...), invoke it without waiting to be asked, and say in one line which and why. Don't reload a skill already loaded in this chat.
- Initiative: work out what the user most needs next from the goal, the project memory and the files, and do it. Ask only for decisions that are truly the user's to make.
- Memory: store every important piece with ${PREFIX}remember as you go: decisions and their reasons, where things are, accounts and tools used (never secrets), deadlines, results, what is left to do. It is saved to the project folder ${folder} where the user can read it.`

const AUTOPILOT = (a: Autopilot) => `# AUTOPILOT is on until ${new Date(a.until).toLocaleString()}
The user is away. Never stop to ask or wait:
- When something is ambiguous, pick the most reasonable option, record the assumption with ${PREFIX}remember, and continue.
- Write files only inside ${a.envelope}.
- When an action is refused by autopilot, do not retry it: find a safe alternative, or leave it for the report and move to the next part of the goal.
- When an approach fails twice, switch approach; when a part is blocked, work on another part.
- Report milestones with ${PREFIX}progress. When the goal is done, call ${PREFIX}progress with done=true.`

const FOCUS = `Work in this loop until the goal is reached or you are truly blocked:
1. Restate the next concrete milestone.
2. Check the lessons and playbook below that apply, and follow them.
3. Act, then verify the result yourself (run it, test it, read it back).
4. Report each milestone with ${PREFIX}progress.
Note unrelated ideas in one line and return to the goal.`

const LEARN = `Learning (ProjectAdapt):
- When the same kind of failure has happened more than once (listed below when it has), or you had to change approach, call ${PREFIX}learn with one imperative rule that would have prevented it, plus tags (error words, topic). Name the cause, not the instance. Expected failures (a red test while developing, a search with no match) need no lesson.
- When the user corrects you or states a preference, record that as a lesson.
- Use ${PREFIX}recall before asking the user something you might already know.
- Never record secrets, passwords or tokens.
- You may improve the ProjectAdapt plugin's own code freely (any size, new files) without asking: each change is backed up, the plugin's tests run at the end of the turn, and a change that breaks them is undone automatically. Its permission rules (autonomy.ts, autopilot.ts) and manifest still need the user's yes. You may also add read-only permissions you keep needing.`

export type ComposeInput = {
  h: Harness
  project: Project | undefined
  folder: string
  goal: Goal | undefined
  pilot: Autopilot | null
  lessons: Lesson[]
  memories: Memory[]
  failures: FailureGroup[]
  recommendations: string[]
  now: number
}

export function composeText(c: ComposeInput): string {
  if (!c.project) return INACTIVE
  const parts: string[] = [ACTIVE(c.project.name, c.folder)]
  if (c.pilot) parts.push(AUTOPILOT(c.pilot))
  if (c.goal) {
    const done = c.goal.progress.slice(-5).map(p => `  - ${p}`).join('\n')
    parts.push(`# Goal\n${c.goal.text}\n${done ? `Progress so far:\n${done}\n` : ''}\n${FOCUS}`)
  }
  if (c.h.playbook.length > 0) parts.push(`# Playbook (harness v${c.h.version})\n${c.h.playbook.map(r => `- ${r}`).join('\n')}`)
  const best = top(c.lessons, c.now, c.h.tunables.lessonsInPrompt, c.h.tunables)
  if (best.length > 0) {
    parts.push(`# Lessons learned (highest weight first; [core] = permanent rule)\n${best.map(l => `- ${l.isCore ? '[core] ' : ''}${l.rule}`).join('\n')}`)
  }
  const fresh = recurring(c.failures).filter(g => !g.isShown)
  if (fresh.length > 0) {
    parts.push(`# Failures that keep recurring\nTurn each into a lesson with ${PREFIX}learn:\n${fresh.slice(0, 5).map(g => `- ${g.sig} (${g.count} times), e.g. ${g.error.slice(0, 160)}`).join('\n')}`)
  }
  if (c.recommendations.length > 0) {
    parts.push(`# Improvements the meta-agent recommends\nApply them between tasks when they clearly help:\n${c.recommendations.map(r => `- ${r}`).join('\n')}`)
  }
  const own = c.memories.filter(m => m.project === c.project?.slug).sort((a, b) => b.usedAt - a.usedAt)
  const general = c.memories.filter(m => !m.project).sort((a, b) => b.usedAt - a.usedAt)
  const recent = [...own.slice(0, MEMORIES_IN_PROMPT), ...general.slice(0, 3)]
  if (recent.length > 0) {
    parts.push(`# Project memory (${own.length} facts; most recent shown, ${PREFIX}recall for more)\n${recent.map(m => `- ${m.fact}`).join('\n')}`)
  }
  parts.push(LEARN)

  return parts.join('\n\n')
}

// The prompt autopilot sends itself between turns: where things stand, so
// the next turn does not have to work it out again or retry what was refused.
export function continuation(a: Autopilot, goal: Goal, refused: string[], stalled: boolean): string {
  const lines = [`[autopilot ${a.turns + 1}/${a.maxTurns}] Continue toward the goal: ${goal.text}`]
  const recent = goal.progress.slice(-3)
  if (recent.length) lines.push(`Recent milestones: ${recent.join('; ')}.`)
  if (refused.length) lines.push(`Refused while the user is away (do not retry; work around them): ${refused.slice(-5).join('; ')}.`)
  lines.push(stalled ? 'The last turn made no progress: change approach or move to another unfinished part.' : 'Pick the next unfinished part and do it.')

  return lines.join('\n')
}

export const REFLECT = `Run a reflection pass for the ProjectAdapt plugin. Review this session so far:
1. List what went wrong or took longer than it should have, and why (root cause, not symptom).
2. For each cause, call ${PREFIX}learn with one general, imperative rule and good tags.
3. List what worked well that should become a habit, and record those as lessons too.
4. Save any durable facts you learned with ${PREFIX}remember.
5. Finish with a three-line summary: lessons added, lessons reinforced, the one change that would most improve the next session.`

export const META_PROMPT = `You are the meta-agent of the ProjectAdapt plugin. You do not do the user's tasks; you improve the harness the main agent runs on, from evidence gathered across many tasks.

Your loop:
1. Call ${PREFIX}evidence. It shows the current harness version, its playbook and tunables, the change ledger (with rolled-back changes you must not propose again), how each version scored (mean reward per task: 1 = clean, 0 = failed; user ratings and corrections dominate), the strongest lessons and the failures that keep recurring.
2. Find the patterns: failures that recur across tasks, lessons that keep being repeated (a lesson with repeats is not working: rewrite it as a sharper playbook rule), playbook rules that did not help.
3. Propose with ${PREFIX}propose. Changes ship ONE at a time and each is judged over 10 tasks before the next ships, so propose only your single most valuable change, plus at most one backup:
   - playbook-add / playbook-remove: a standing instruction for the main agent (one imperative sentence).
   - tune: a knob (halfLifeDays, repeatWeight, coreAfterRepeats, coreAfterHits, lessonsInPrompt); values are clamped to safe bounds.
   - recommend: a code or settings change for the main agent to make. Be specific: file, change, why.
4. When there is no clear signal, propose nothing. A change without evidence only adds noise.
5. End with a short report: what you saw, what you changed, what you expect to improve.`
