import { expect, test } from 'claude-code/testing'

import { decide, isHomeLike, workFolder } from './autopilot'
import { remaining } from './band'
import { parseDuration } from './commands'
import { appendLog, folderOf, redact, slugify } from './projects'

const CWD = 'C:\\Users\\me\\proj'

test('questions to the absent user are answered, not waited on', async () => {
  const v = decide('AskUserQuestion', {}, CWD, false, undefined)
  expect(v.decision).toBe('deny')
  expect(v.reason).toMatch(/most reasonable option/)
})

test('work inside the project goes ahead', async () => {
  expect(decide('Edit', { file_path: `${CWD}\\src\\a.ts` }, CWD, false, undefined).decision).toBe('allow')
  expect(decide('PowerShell', { command: 'npm test' }, CWD, false, undefined).decision).toBe('allow')
  expect(decide('Grep', {}, CWD, true, undefined).decision).toBe('allow')
})

test('irreversible or outward actions are refused with a way forward', async () => {
  expect(decide('Edit', { file_path: 'C:\\Windows\\hosts' }, CWD, false, undefined).decision).toBe('deny')
  expect(decide('Edit', { file_path: `${CWD}\\.git\\config` }, CWD, false, undefined).decision).toBe('deny')
  expect(decide('Bash', { command: 'git push origin main' }, CWD, false, undefined).decision).toBe('deny')
  expect(decide('PowerShell', { command: 'Remove-Item C:\\data -Recurse -Force' }, CWD, false, undefined).decision).toBe('deny')
  expect(decide('mcp__claude_ai_Gmail__send_message', {}, CWD, false, undefined).decision).toBe('deny')
  expect(decide('Edit', { file_path: `${CWD}\\x.ts` }, CWD, false, 'major').decision).toBe('deny')
})

test("other plugins' read-only claims are vetted", async () => {
  expect(decide('mcp__claude_ai_Google_Drive__search_files', {}, CWD, true, undefined).decision).toBe('allow')
  expect(decide('mcp__claude_ai_Gmail__send_message', {}, CWD, true, undefined).decision).toBe('deny')
  expect(decide('mcp__someserver__do_stuff', {}, CWD, true, undefined).decision).toBe('deny')
  expect(decide('Read', {}, CWD, true, undefined).decision).toBe('allow')
})

test('from the home folder, writes are limited to a work folder', async () => {
  const home = 'C:\\Users\\me'
  expect(isHomeLike(home, home)).toBe(true)
  expect(isHomeLike('C:\\', home)).toBe(true)
  expect(isHomeLike(CWD, home)).toBe(false)
  const envelope = workFolder(home, 'demo-project')
  expect(decide('Write', { file_path: `${home}\\projectadapt-work\\demo-project\\draft.md` }, envelope, false, undefined).decision).toBe('allow')
  expect(decide('Write', { file_path: `${home}\\Documents\\other.md` }, envelope, false, undefined).decision).toBe('deny')
})

test('secrets are taken out of what is written to disk', async () => {
  const out = redact('auth: Bearer abcdefghijklmnop1234 and key sk-ABCDEFGHIJKLMNOPQRSTUV and password=hunter22')
  expect(out).not.toMatch(/abcdefghijklmnop1234|ABCDEFGHIJKLMNOP|hunter22/)
})

test('durations and the band clock', async () => {
  expect(parseDuration('30m')).toBe(0.5)
  expect(parseDuration('1.5h')).toBe(1.5)
  expect(parseDuration('2')).toBe(2)
  expect(parseDuration('finish')).toBe(undefined)
  expect(remaining(134 * 60_000)).toBe('2h14m')
})

test('project folders and logs', async () => {
  expect(slugify('Demo Project #3!')).toBe('demo-project-3')
  expect(folderOf('C:\\Users\\me', 'demo-project')).toBe('C:/Users/me/.claude/projectadapt/projects/demo-project')
  const log = appendLog('', ['activated'], 0)
  expect(log.startsWith('# Log')).toBe(true)
  expect(log).toMatch(/activated/)
})
