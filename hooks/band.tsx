// A band above the prompt while /away runs: how far along it is, how long is
// left, the last milestone and how many things wait for the person. It is
// drawn from session state, so it redraws whenever autopilot's state changes,
// and shows nothing at all when /away is off.

import type { On } from 'claude-code'

import { goalOf } from './io'
import { readAutopilot, readAway } from './store'

export function remaining(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const h = Math.floor(minutes / 60)

  return h > 0 ? `${h}h${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`
}

export function installBand(on: On): void {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const pilot = await readAutopilot($)
    if (!pilot || e.props.hasSurvey) return next(e)
    const waiting = (await readAway($)).length
    const goal = await goalOf($, pilot.project)
    const last = goal?.progress[goal.progress.length - 1]
    const left = remaining(pilot.until - (await $.clock.now()))
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text color="cyan" bold>
          AWAY{' '}
        </Text>
        <Text dimColor>
          turn {pilot.turns}/{pilot.maxTurns} · {left} left{last ? ` · last: ${last.slice(0, 40)}` : ''} · {waiting} need you ·{' '}
          {pilot.paused ? 'paused: /away resume' : 'Esc stops'}
        </Text>
      </Box>
    )
  })
}
