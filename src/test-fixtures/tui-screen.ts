import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { z } from 'zod'

const terminalFrame = z.object({ frame: z.string(), ansi: z.string() })

// Observe real terminal cells and send actual SGR mouse events, never invoke plugin callbacks.
export async function driveSidebar(
  child: Bun.Subprocess<'pipe', 'pipe', 'pipe'>,
  evidence: string
): Promise<void> {
  let phase: 'collapsed' | 'expanded' | 'recollapsed' = 'collapsed'
  let pending = ''
  let ansi = ''
  const decoder = new TextDecoder()
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
        if (header) {
          const collapsed = header.includes('12 obs') || header.includes('(offline)')
          const expanded =
            frame.includes('Latest observation fixture') || frame.includes('worker offline')
          const matches = phase === 'expanded' ? expanded : collapsed && !expanded
          if (matches) {
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
            const column = header.indexOf('Memory') + 2
            const mouse = `\u001b[<0;${column + 1};${row + 1}M\u001b[<0;${column + 1};${row + 1}m`
            child.stdin.write(`${JSON.stringify(mouse)}\n`)
          }
        }
      }
    }
    throw new Error(`Terminal exited before ${phase} capture`)
  } finally {
    await writeFile(join(evidence, 'terminal.ansi'), ansi)
  }
}
