// Which self-changes ProjectAdapt makes without asking.
//
// minor (applied without a prompt): ANY change to the plugin's own code and
//   files (edits of any size, new files, whole-file rewrites). Each one is
//   backed up first and, at the end of the turn, the plugin's tests run; a
//   change that breaks them is restored automatically (see selfcheck.ts).
//   Also: adding read-only allow rules to a Claude Code settings file.
// major (the person is asked):
//   - this file and autopilot.ts, which decide what ProjectAdapt may do on the
//     machine, plus the manifest and hooks.json, which load the code
//   - an edit to the lines that call these rules (classify, decide, the
//     tool.check hook), since editing them could switch the rules off
//   - any other settings change: removing rules, deny/ask lists, defaultMode,
//     hooks, env, broad or write-capable allow rules
// Anything else is left to Claude Code's own permission rules.

export type Tier = { tier: 'minor' | 'major'; reason: string; kind: 'code' | 'settings' }

const PROTECTED = ['hooks/autonomy.ts', 'hooks/autopilot.ts', 'hooks/hooks.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json']
// Code that wires the rules in: changing it could bypass them.
const RULE_WIRING = /tool\.check|classify\(|decide\(|bypass/i
const SETTINGS = /\/\.claude\/settings(\.local)?\.json$/
const WRITERS = new Set(['Edit', 'Write', 'NotebookEdit'])

// Read-only rules only: a tool that cannot change anything, or a shell
// command that only reads. No shell metacharacters, no other wildcards.
const SAFE_RULES = [
  /^(Read|Glob|Grep|WebSearch|LS|NotebookRead)(\([^()]*\))?$/,
  /^mcp__projectadapt__(recall|remember|learn|progress|propose|evidence)$/,
  /^(Bash|PowerShell)\((git (status|diff|log|show|branch)|ls|pwd|rg|Get-ChildItem|Get-Content|Select-String|Test-Path|Get-Location|claude plugin validate)(:\*| [^;&|`$<>()]*)?\)$/,
]

const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()
const strings = (s: string) => [...s.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1] ?? '')
const skeleton = (s: string) => s.replace(/"((?:[^"\\]|\\.)*)"/g, '').replace(/[\s,]/g, '')

export function isSafeRule(rule: string): boolean {
  return SAFE_RULES.some(r => r.test(rule))
}

export function classify(tool: string, input: Record<string, unknown>, pluginRoot: string): Tier | undefined {
  if (!WRITERS.has(tool)) return undefined
  const raw = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : ''
  const path = norm(raw)
  if (!path) return undefined
  const root = norm(pluginRoot).replace(/\/$/, '') + '/'
  const before = typeof input.old_string === 'string' ? input.old_string : ''
  const after = typeof input.new_string === 'string' ? input.new_string : typeof input.content === 'string' ? input.content : typeof input.new_source === 'string' ? input.new_source : ''

  if (path.startsWith(root)) {
    const rel = path.slice(root.length)
    if (PROTECTED.includes(rel)) return { tier: 'major', kind: 'code', reason: `ProjectAdapt: ${rel} decides what ProjectAdapt may do on your computer` }
    if (rel === 'hooks/register.ts' && (RULE_WIRING.test(after) || RULE_WIRING.test(before))) {
      return { tier: 'major', kind: 'code', reason: 'projectadapt: touches the code that applies its permission rules' }
    }

    return { tier: 'minor', kind: 'code', reason: `ProjectAdapt: self-improvement to ${rel}` }
  }

  if (SETTINGS.test(path)) {
    if (tool !== 'Edit') return { tier: 'major', kind: 'settings', reason: 'projectadapt: rewrites a whole settings file' }
    const old = strings(before)
    const added = strings(after).filter(s => !old.includes(s))
    const removed = old.filter(s => !strings(after).includes(s))
    // Only strings were added: brackets, keys and values are untouched.
    const sameShape = skeleton(before) === skeleton(after)
    if (removed.length === 0 && added.length > 0 && added.every(isSafeRule) && sameShape) {
      return { tier: 'minor', kind: 'settings', reason: `ProjectAdapt: adds read-only permission ${added.join(', ')}` }
    }

    return { tier: 'major', kind: 'settings', reason: 'projectadapt: changes settings beyond adding read-only permissions' }
  }

  return undefined
}
