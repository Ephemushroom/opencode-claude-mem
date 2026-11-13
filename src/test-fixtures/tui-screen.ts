import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { z } from 'zod'

const terminalFrame = z.object({ frame: z.string(), ansi: z.string() })

// Hover first: the host tracks any-motion (1003) and hit-tests from the pointer.
function clickAt(line: string, row: number, target = 'Memory'): string {
  const at = `${line.indexOf(target) + 3};${row + 1}`
  return `\u001b[<35;${at}M\u001b[<0;${at}M\u001b[<0;${at}m`
}

// Observe real terminal cells and send actual SGR mouse events, never invoke plugin callbacks.
export async function driveSidebar(
  child: Bun.Subprocess<'pipe', 'pipe', 'pipe'>,
  evidence: string
): Promise<void> {
  let phase: 'collapsed' | 'expanded' | 'detail' | 'recollapsed' = 'collapsed'
  let pending = ''
  let ansi = ''
  let click: string | undefined = undefined
  const decoder = new TextDecoder()
  // A click delivered while the host is still mounting the session can be dropped,
  // so repeat it until the next state is observed, as a person would click again.
  const retry = setInterval(() => {
    if (click) {
      child.stdin.write(`${JSON.stringify(click)}\n`)
    }
  }, 2000)
  try {
    for await (const chunk of child.stdout.values({ preventCancel: true })) {
      pending += decoder.decode(chunk, { stream: true })
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const { frame, ansi: next } = terminalFrame.parse(JSON.parse(line))
        ansi += next
        // eslint-disable-next-line no-await-in-loop
        await writeFile(join(evidence, 'last-frame.txt'), frame)
        if (frame.includes('crashed in slot') || frame.includes('plugin failed')) {
          throw new Error(`Host plugin failed:\n${frame}`)
        }
        const rows = frame.split('\n')
        const row = rows.findIndex((text) => text.includes('Memory'))
        const header = rows[row]
        const item = rows.findIndex((text) => text.includes('Latest observation fixture'))
        if (header && click) {
          // The layout can shift after a capture; aim retries at the target's current cell.
          click =
            phase === 'detail' && rows[item]
              ? clickAt(rows[item], item, 'Latest observation fixture')
              : clickAt(header, row)
        }
        if (header) {
          // Project counts come from the fixture database; the global total stays secondary.
          const collapsed = header.includes('(online, 7 obs)') || header.includes('(offline)')
          // Expanded rows drop the project prefix and show each item's age.
          const expanded =
            (frame.includes('Latest observation fixture') &&
              frame.includes('all 12 obs') &&
              frame.includes('• Recent session fixture') &&
              /1[12]m ago · #2/.test(frame)) ||
            frame.includes('worker offline')
          const detail = frame.includes('Detail dialog fixture fact')
          const matches = {
            collapsed: collapsed && !expanded && !detail,
            expanded,
            detail,
            recollapsed: collapsed && !expanded && !detail,
          }[phase]
          if (matches) {
            click = undefined
            // eslint-disable-next-line no-await-in-loop
            await writeFile(join(evidence, `${phase}.txt`), frame)
            // Retain the truecolor stream at each state for xterm/browser screenshot replay.
            // eslint-disable-next-line no-await-in-loop
            await writeFile(join(evidence, `${phase}.ansi`), ansi)
            process.stdout.write(`Captured ${phase}\n${frame}\n`)
            switch (phase) {
              case 'collapsed': {
                phase = 'expanded'
                break
              }
              case 'expanded': {
                // Offline has no items to open; go straight to collapsing.
                phase = frame.includes('worker offline') ? 'recollapsed' : 'detail'
                break
              }
              case 'detail': {
                // Close the dialog before clicking the header again.
                child.stdin.write(`${JSON.stringify('\u001b')}\n`)
                phase = 'recollapsed'
                break
              }
              case 'recollapsed': {
                return
              }
              default: {
                throw new Error(`Unknown sidebar phase: ${phase satisfies never}`)
              }
            }
            click =
              phase === 'detail' && rows[item]
                ? clickAt(rows[item], item, 'Latest observation fixture')
                : clickAt(header, row)
            child.stdin.write(`${JSON.stringify(click)}\n`)
          }
        }
      }
    }
    throw new Error(`Terminal exited before ${phase} capture`)
  } finally {
    clearInterval(retry)
    await writeFile(join(evidence, 'terminal.ansi'), ansi)
  }
}
