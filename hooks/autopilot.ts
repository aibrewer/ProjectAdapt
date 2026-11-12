// Autopilot: Claude keeps working while the person is away, and never stops
// to wait for them. Every call that would put a question to the person is
// answered on the spot instead:
//   - allowed, when it stays inside a safe envelope (reads, work inside the
//     project folder, ordinary local commands)
//   - refused, with a reason that tells Claude to find another way, when it
//     is irreversible or reaches outside the machine: deleting outside the
//     project, pushing, publishing, sending messages, payments, permission
//     and settings changes, major self-changes. Refusals are logged for the
//     person's return.
// Nothing waits, and nothing the person could not undo happens unattended.

export const DEFAULT_HOURS = 4
export const DEFAULT_MAX_TURNS = 200
export const MAX_STALLS = 4
// After a turn that ended on an API error, wait before the next one.
export const ERROR_BACKOFF_MS = 60_000

// Shell commands that destroy, publish or reach out. Matched case-insensitively.
const DANGEROUS_SHELL =
  /\b(rm\s+-[a-z]*r|rmdir|del\s|erase\s|remove-item\b.*-recurse|format\s|shutdown|restart-computer|stop-computer|git\s+(push|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|branch\s+-D|rebase|filter-branch)|gh\s+(repo|pr|release|issue)\s+(create|delete|merge|edit)|npm\s+publish|pip\s+upload|twine\s+upload|docker\s+push|curl\b.*-X\s*(POST|PUT|DELETE|PATCH)|invoke-(webrequest|restmethod)\b.*-method\s+(post|put|delete|patch)|send-mailmessage|reg\s+(add|delete)|set-itemproperty\s+.*hk(lm|cu)|icacls|takeown|netsh|sc\s+(delete|config)|schtasks\s+\/create|winget\s+(install|uninstall)|choco\s+(install|uninstall)|npm\s+i(nstall)?\s+-g|setx\b)/i

// Tools that send, publish, delete or spend: refused on autopilot.
const OUTWARD_TOOL = /(send|reply|forward|post|publish|share|delete|trash|purchase|buy|checkout|transfer|create_event|update_event|respond_to_event|invite|payment|submit)/i

// Tools whose only purpose is a question to the person.
const ASKS_PERSON = /^(AskUserQuestion|ExitPlanMode|EnterPlanMode)$/

// Another plugin's tool saying it is read-only is only its own word. On
// autopilot that word is accepted only when the tool's name says it reads
// (get, list, search...) and nothing in it says it sends, deletes or spends.
const READ_VERB = /^(get|list|search|read|query|find|lookup|describe|view|show|count|check|fetch|download|export|whoami|healthcheck|cache_stats|usage|provider_)/i

export function vetReadOnly(tool: string): boolean {
  if (!tool.startsWith('mcp__') || tool.startsWith('mcp__projectadapt__')) return true
  const name = tool.split('__').pop() ?? ''

  return READ_VERB.test(name) && !OUTWARD_TOOL.test(name)
}

const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')

// The home folder or a drive root is no project: autopilot then writes only
// inside a work folder of its own for the project.
export function isHomeLike(cwd: string, home: string): boolean {
  const c = norm(cwd)

  return c === norm(home) || /^[a-z]:$/.test(c) || c === ''
}

export const workFolder = (home: string, slug: string) => `${home.replace(/\\/g, '/').replace(/\/$/, '')}/projectadapt-work/${slug}`

export type AutopilotVerdict = { decision: 'allow' | 'deny'; reason: string; logged: boolean }

export function decide(
  tool: string,
  input: Record<string, unknown>,
  envelope: string,
  isReadOnly: boolean,
  selfTier: 'minor' | 'major' | undefined,
): AutopilotVerdict {
  const cwd = envelope
  const refuse = (why: string): AutopilotVerdict => ({
    decision: 'deny',
    reason: `Autopilot: the user is away and ${why}. Do not wait or ask: choose a safe alternative that stays inside the project, or note it in the final report and move on to the next part of the goal.`,
    logged: true,
  })

  if (ASKS_PERSON.test(tool)) {
    return {
      decision: 'deny',
      reason: 'Autopilot: the user is away and cannot answer. Choose the most reasonable option yourself, record the assumption with mcp__projectadapt__remember, and continue.',
      logged: true,
    }
  }
  if (selfTier === 'major') return refuse('this is a major change to the plugin or its permissions, which only the user may approve; it is listed for their review')
  if (selfTier === 'minor') return { decision: 'allow', reason: 'Autopilot: minor self-change', logged: false }
  if (isReadOnly) {
    if (vetReadOnly(tool)) return { decision: 'allow', reason: 'Autopilot: read-only', logged: false }

    return refuse(`${tool} claims to be read-only, but its name does not show that it only reads`)
  }

  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') {
    const path = norm(typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : '')
    const root = norm(cwd) + '/'
    if (path.startsWith(root) && !/\/\.(git|claude)\//.test(path.slice(root.length - 1))) {
      return { decision: 'allow', reason: 'Autopilot: edit inside the project', logged: false }
    }

    return refuse(`editing ${path || 'that file'} reaches outside the folder autopilot may write in (${cwd})`)
  }

  if (tool === 'Bash' || tool === 'PowerShell') {
    const command = typeof input.command === 'string' ? input.command : ''
    if (DANGEROUS_SHELL.test(command)) return refuse(`\`${command.slice(0, 80)}\` could destroy data, publish, or change the system`)

    return { decision: 'allow', reason: 'Autopilot: local command', logged: false }
  }

  if (OUTWARD_TOOL.test(tool)) return refuse(`${tool} sends, publishes, deletes or spends on the user's behalf`)

  // Anything else that would have asked: refuse rather than wait.
  return refuse(`${tool} needs the user's approval`)
}
