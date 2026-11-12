# ProjectAdapt

A Claude Code plugin that makes Claude get better the more you use it, and lets it drive a project with as little input from you as possible.

## Start here: one command per chat

```
/activate <project name or what you want done>
```

That's the only input it needs. In a new chat, ProjectAdapt stays off until you activate it. Once you do, Claude:

- **Uses skills on its own** when a task clearly matches one (documents, spreadsheets, data, browser...).
- **Takes initiative:** it works out the goal from your description, the folder and its project memory, sets the goal, and starts.
- **Saves as it goes:** decisions, file locations, deadlines, results and what's left are saved to a folder per project:

```
~/.claude/projectadapt/projects/<project>/
  README.md        what the project is, its goal, when it was activated
  memory.md        every fact saved for the project
  lessons.md       what was learned while working on it
  log.md           milestones, task results, self-changes, anything that needs you
  away-report.md   what happened during your last /away
  snapshot.json    a full backup (from /adapt save)
```

Secrets (API keys, tokens, passwords) are blanked out of everything written there. Activating the same project in a later chat picks up where it left off.

## Stepping away: /away

```
/away 2h                 keep working for 2 hours (also 30m, 1.5h; default 4h)
/away 3h finish the report    ...with a new goal
/away resume             continue after it paused
/away off                stop
```

If ProjectAdapt isn't active yet, `/away` activates it for the current folder. Claude then keeps going turn after turn without waiting for you. When something is unclear it picks the most reasonable option and writes the assumption down. When an approach fails it switches approach, and when a part is blocked it moves on to another part. A bar above the prompt shows the turn count, time left, last milestone and how many things need you.

- **Typing pauses it.** Anything you type pauses `/away` so your message doesn't collide with its work; `/away resume` continues.
- **Nothing irreversible happens while you're gone.** Deleting outside the project, `git push`, publishing, sending emails or messages, purchases and system changes are skipped on the spot rather than waited on, and listed under "Needs you".
- **Other plugins' "read-only" claims are checked:** a tool from another plugin only counts as read-only if its name says it reads (get, list, search...).
- **From your home folder,** writes are limited to `~/projectadapt-work/<project>`.
- **It stops** when the goal is done, the time runs out, after 200 turns, after 4 turns in a row with no progress, or when you press Esc.
- **When it stops**, it writes `away-report.md` (needs you, done, assumptions made, files changed), shows a one-line summary and sends a desktop notification.

## How it learns

**Lessons.** Failures are grouped by kind. When the same kind happens more than once, Claude writes a general rule (a *lesson*). When that failure comes up again, the lesson is shown right next to the error. A lesson only matches a failure that shares at least two meaningful words with it; a tool name alone doesn't count. Failing test and build runs don't count as mistakes. Each lesson's weight is:

```
score = (1 + hits + 3 × repeats) × 0.5 ^ (days since it last mattered / 30)
```

A lesson reinforced 4 times, or repeated twice, becomes **permanent**.

**The outer loop.** Each task you start is scored. Your `/rate` counts most, then whether you corrected or interrupted it, then how cleanly its tool calls went. When there's new evidence (new kinds of failure, new ratings), a background **meta-agent** reviews it and proposes a change to Claude's standing instructions or the formula's settings. Changes ship **one at a time**. Each runs for 10 tasks and is kept or rolled back automatically by comparing scores, and a rolled-back change is never proposed again. The meta-agent can't change how it's judged, and it pauses during `/away`.

## Autonomy: it improves itself without asking

Claude can change **any of ProjectAdapt's own code** (edits of any size, new files, rewrites) without asking. To make that safe to leave running:

1. Every self-change is **backed up** first (in `~/.claude/projectadapt/backups/`).
2. At the end of the turn the plugin **validates itself and runs its tests**.
3. If a self-change broke them, it's **undone automatically** from the backup and recorded as a lesson.

It also adds read-only permissions it keeps needing on its own. Only these still ask you:

- `autonomy.ts` and `autopilot.ts` (the rules for what ProjectAdapt may do on your computer), the manifest and `hooks.json`, and the lines that apply those rules.
- Settings changes beyond adding read-only permissions.

`/adapt changes` lists every self-change and `/adapt undo` reverts the last one.

## Commands

| Command | What it does |
|---|---|
| `/activate <project>` | Turn ProjectAdapt on for a project in this chat (once per chat) |
| `/away [time] [goal]` | Keep working while you step away; `off`, `resume` |
| `/rate <1-5> [note]` | Score the last task: the strongest way to steer it |
| `/adapt` | Status: project, goal, away, what it's learned |
| `/adapt goal [text\|clear]` | Show, set or clear the goal (also `/hyperfocus`) |
| `/adapt reflect` | Turn this chat into lessons (also `/reflect`) |
| `/adapt lessons` | What it's learned (also `/lessons`) |
| `/adapt save` | Save everything to the project folder |
| `/adapt help` | All commands |
| Advanced | `/adapt harness`, `meta`, `changes`, `undo`, `rollback`, `forget <id>`, `reset` (asks first and saves a snapshot) |

## Settings

In `/config`, under ProjectAdapt: **Meta-agent** on/off (it uses tokens), **Longest /away run** (hours) and **Most turns per /away run**.

## What it can't do

It improves Claude's *harness* (instructions, memory, its own code), not the model itself, which no plugin can retrain. Claude Code must stay open, and the computer awake, for `/away` to keep running. Long runs use tokens on your account.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin marketplace add aibrewer/ProjectAdapt
/plugin install projectadapt@projectadapt
```

From a shell: `claude plugin marketplace add aibrewer/ProjectAdapt` then `claude plugin install projectadapt@projectadapt`. To try it from a local clone: `claude --plugin-dir /path/to/ProjectAdapt`.

## License

MIT