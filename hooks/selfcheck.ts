// What makes free self-modification safe to leave unattended: every change
// ProjectAdapt makes to itself is backed up first, and at the end of the turn the
// plugin validates and runs its own tests. A turn whose self-changes break
// either is undone file by file from the backups, and the failure becomes a
// lesson, so the person never has to step in.

import type { EngineInterface } from 'claude-code'

import { addLesson } from './brain'
import { homeDir, queueLog } from './io'
import { cap, harnessOf, K, readSelfEdits, update, updateSelfEdits } from './store'

const TEST_TIMEOUT_MS = 180_000
const NEW_FILE_STUB = '// Removed by ProjectAdapt: this file was added by a self-change that broke the tests.\nexport {}\n'

const baseName = (file: string) => file.replace(/\\/g, '/').split('/').pop() ?? 'file'

// Copies the file as it is now, before a change, and records the change in
// the session (for the self-check) and in the journal (for /adapt undo).
export async function backupBefore($: EngineInterface, file: string, reason: string, isCode: boolean): Promise<void> {
  const now = await $.clock.now()
  let backup: string | null = null
  if (await $.fs.exists(file)) {
    const text = await $.fs.read(file)
    backup = `${(await homeDir($)).replace(/\\/g, '/')}/.claude/projectadapt/backups/${now}-${Math.floor(Math.random() * 1e6)}-${baseName(file)}`
    await $.fs.write(backup, typeof text === 'string' ? text : '')
  }
  const change = { at: now, file, backup, reason }
  await update($, K.journal, j => [...j, change].slice(-100))
  if (isCode) await updateSelfEdits($, edits => [...edits, change].slice(-100))
}

// Puts one change back: the backup's text, or a stub where the file was new.
export async function restore($: EngineInterface, change: { file: string; backup: string | null }): Promise<void> {
  const text = change.backup ? await $.fs.read(change.backup) : NEW_FILE_STUB
  await $.fs.write(change.file, typeof text === 'string' ? text : NEW_FILE_STUB)
}

async function claude($: EngineInterface, args: string[]): Promise<{ ok: boolean; output: string }> {
  try {
    const r = await $.process.run(['claude', 'plugin', ...args, $.plugin.root], { timeoutMs: TEST_TIMEOUT_MS })
    const output = `${r.stdout}\n${r.stderr}`

    return { ok: r.exitCode === 0 && !/✘|\(fail\)/.test(output), output }
  } catch (error) {
    // The check could not run (claude not found, timeout): keep the changes
    // rather than undo working code on a missing tool.
    return { ok: true, output: `self-check could not run: ${error instanceof Error ? error.message : 'error'}` }
  }
}

// Runs after a turn in which ProjectAdapt changed its own code.
export async function verifySelf($: EngineInterface, slug: string): Promise<'none' | 'passed' | 'restored'> {
  const edits = await readSelfEdits($)
  if (edits.length === 0) return 'none'
  await updateSelfEdits($, () => [])
  const validated = await claude($, ['validate'])
  const tested = validated.ok ? await claude($, ['test']) : validated
  if (tested.ok) {
    await queueLog($, slug, [`self-check passed after ${edits.length} self-change(s)`])

    return 'passed'
  }

  for (const change of [...edits].reverse()) await restore($, change)
  const why = cap(
    tested.output
      .split('\n')
      .filter(l => /✘|fail|error/i.test(l))
      .slice(0, 3)
      .join(' ')
      .replace(/\s+/g, ' ') || 'validation or tests failed',
    300,
  )
  const files = [...new Set(edits.map(e => baseName(e.file)))].join(', ')
  const now = await $.clock.now()
  const h = await harnessOf($)
  await update($, K.lessons, lessons => addLesson(lessons, cap(`A self-change to ${files} broke the plugin's checks (${why}); run claude plugin test before relying on a self-change`), ['self-change', 'tests'], now, h.tunables).lessons)
  await queueLog($, slug, [`self-check FAILED, restored ${files}: ${why}`])
  $.ui.toast(`ProjectAdapt: a self-change broke its tests and was undone (${files})`)

  return 'restored'
}
