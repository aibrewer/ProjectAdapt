import { expect, test } from 'claude-code/testing'

import { addLesson, match, recordFailure, reinforce, score, toolWordsOf, top, words } from './brain'
import type { Lesson } from './brain'

const DAY = 86_400_000

test('a near-duplicate lesson merges and gains weight', async () => {
  const first = addLesson([], 'Quote file paths that contain spaces in PowerShell commands', ['PowerShell'], 0)
  const second = addLesson(first.lessons, 'In PowerShell commands, always quote file paths with spaces', [], DAY)

  expect(second.isNew).toBe(false)
  expect(second.lessons.length).toBe(1)
  expect(second.lesson.hits).toBe(2)
})

test('repeats outweigh hits, and repeats promote to core', async () => {
  const { lessons, lesson } = addLesson([], 'Run tests before reporting a fix', ['tests'], 0)
  const once = reinforce(lessons, [lesson.id], 0)
  const twice = reinforce(once, [lesson.id], 0)

  expect(score(once[0] as Lesson, 0)).toBe(1 + 1 + 3)
  expect((twice[0] as Lesson).isCore).toBe(true)
})

test('lessons decay with a 30-day half-life unless core', async () => {
  const { lesson } = addLesson([], 'Check the working directory first', [], 0)

  expect(score(lesson, 30 * DAY)).toBe(score(lesson, 0) / 2)
  expect(score({ ...lesson, isCore: true }, 300 * DAY)).toBe(score(lesson, 0))
})

test('a failure finds the lesson about it', async () => {
  const { lessons } = addLesson([], 'Use Get-Content, not cat with flags, in PowerShell', ['powershell', 'bash'], 0)
  const found = match(lessons, words('Bash failed: cat -n is not recognized in PowerShell'), 0)

  expect(found.length).toBe(1)
})

test('a tool name alone is not a match', async () => {
  const { lessons } = addLesson([], 'Quote paths with spaces', ['powershell'], 0)
  const found = match(lessons, words('PowerShell failed: timeout waiting for network'), 0, 3, undefined, toolWordsOf('PowerShell'))

  expect(found.length).toBe(0)
})

test('failures of one kind group together, whatever the numbers and paths', async () => {
  const a = recordFailure([], 'Bash', 'cmd', "error: file 'C:/x/a.txt' not found at line 12", 0)
  const b = recordFailure(a.groups, 'Bash', 'cmd', "error: file 'D:/y/b.txt' not found at line 40", 1)

  expect(b.isNewKind).toBe(false)
  expect(b.group.count).toBe(2)
})

test('core lessons always make the top list', async () => {
  let lessons: Lesson[] = []
  for (let i = 0; i < 20; i++) lessons = addLesson(lessons, `distinct rule number ${i} about topic${i}`, [], i).lessons
  lessons = lessons.map((l, i) => (i === 0 ? { ...l, isCore: true } : { ...l, hits: 10 }))

  expect(top(lessons, 0, 5).some(l => l.isCore)).toBe(true)
})
