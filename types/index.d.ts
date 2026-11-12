// Session state: one chat's own values. Each new chat starts empty, and a
// reload of the plugin's code keeps them. Cross-chat data lives in $.store.

export type Autopilot = {
  project: string
  startedAt: number
  until: number
  maxTurns: number
  turns: number
  // Consecutive turns that made no progress (no tool call, no milestone).
  stalls: number
  // Set when the person types while autopilot runs; /away resume clears it.
  paused: boolean
  // The folder autopilot may write in: the project folder, or a work folder
  // when the chat runs in the home folder or a drive root.
  envelope: string
  // Files written during the run, for the welcome-back report.
  files: string[]
  // How many milestones the goal had when the run started.
  milestonesAtStart: number
}

export type Live = {
  calls: number
  failures: number
  progressed: boolean
  // Lessons already reinforced this turn: at most one repeat per turn.
  repeated: string[]
}

export type MetaRun = { id: string; at: number }

export type LogEntry = { slug: string; line: string }

// A self-change made this turn, with the backup taken just before it (null
// when the file was new).
export type SelfEdit = { at: number; file: string; backup: string | null; reason: string }

declare module 'claude-code' {
  interface PluginState {
    projectadapt: {
      // The project this chat was activated for ('' until /activate).
      project: string
      autopilot: Autopilot | null
      live: Live
      // What autopilot refused, for the welcome-back report.
      away: string[]
      meta: MetaRun | null
      // The ProjectAdapt section of the system prompt, frozen for the current turn.
      compose: string
      // Who started the current turn: the person, or a plugin's own prompt.
      origin: 'user' | 'plugin'
      // Project-folder log lines waiting for the next flush.
      logQueue: LogEntry[]
      // Self-changes waiting for the end-of-turn self-check.
      selfEdits: SelfEdit[]
    }
  }
}
