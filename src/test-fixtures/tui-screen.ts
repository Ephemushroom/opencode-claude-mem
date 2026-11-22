import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { z } from 'zod'

const terminalFrame = z.object({
  frame: z.string(),
  ansi: z.string(),
  backgrounds: z.array(z.array(z.string())),
  checkpoint: z.string().optional(),
})

function assertDialogBounds(frame: string, backgrounds: string[][]): void {
  assert.equal(backgrounds.length, 40)
  assert.ok(backgrounds.every((row) => row.length === 140))
  const rows = frame.split('\n')
  const row = rows.findIndex((text) => text.includes('Detail dialog fixture fact'))
  const column = rows[row]?.indexOf('Detail dialog fixture fact') ?? -1
  assert.ok(row !== -1 && column !== -1, 'detail must persist after mouse release')
  const color = backgrounds[row]?.[column]
  let left = column
  let right = column
  while (left > 0 && backgrounds[row]?.[left - 1] === color) {
    left--
  }
  while (right < 139 && backgrounds[row]?.[right + 1] === color) {
    right++
  }
  let top = row
  let bottom = row
  while (top > 0 && backgrounds[top - 1]?.[left] === color) {
    top--
  }
  while (bottom < 39 && backgrounds[bottom + 1]?.[left] === color) {
    bottom++
  }
  assert.ok(right - left + 1 >= 84, `detail too narrow: ${right - left + 1} cells`)
  assert.ok(
    left > 0 && right < 139,
    `detail bounds indistinguishable from screen: ${left}..${right}`
  )
  assert.ok(
    Math.abs(left - (139 - right)) <= 2,
    `detail not horizontally centered: ${left}..${right}`
  )
  assert.ok(Math.abs(top - (39 - bottom)) <= 2, `detail not vertically centered: ${top}..${bottom}`)
  process.stdout.write(`Detail bounds: ${JSON.stringify({ left, right, top, bottom })}\n`)
}

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
  let detailAt = ''
  let checkpointTimer: ReturnType<typeof setTimeout> | undefined = undefined
  const checkpoint = (name: string) => {
    checkpointTimer = setTimeout(() => {
      child.stdin.write(`${JSON.stringify({ checkpoint: name })}\n`)
    }, 500)
  }
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
        const {
          frame,
          ansi: next,
          backgrounds,
          checkpoint: check,
        } = terminalFrame.parse(JSON.parse(line))
        ansi += next
        // eslint-disable-next-line no-await-in-loop
        await writeFile(join(evidence, 'last-frame.txt'), frame)
        if (frame.includes('crashed in slot') || frame.includes('plugin failed')) {
          throw new Error(`Host plugin failed:\n${frame}`)
        }
        if (check === 'held') {
          await writeFile(join(evidence, 'detail-held.txt'), frame)
          child.stdin.write(`${JSON.stringify(`\u001b[<0;${detailAt}m`)}\n`)
          checkpoint('released')
          continue
        }
        if (check === 'released') {
          await writeFile(join(evidence, 'detail-released.txt'), frame)
          await writeFile(join(evidence, 'detail.ansi'), ansi)
          assertDialogBounds(frame, backgrounds)
          assert.ok(
            frame.includes('Checks Markdown rendering inside renderDetail.'),
            'detail must render concealed Markdown'
          )
          assert.ok(
            !frame.includes('Detail scroll end marker'),
            'long detail must overflow the viewport'
          )
          child.stdin.write(
            `${JSON.stringify(`\u001b[<35;70;20M${'\u001b[<65;70;20M'.repeat(80)}`)}\n`
          )
          checkpoint('scrolled')
          continue
        }
        if (check === 'scrolled') {
          await writeFile(join(evidence, 'detail-scrolled.txt'), frame)
          assert.ok(
            frame.includes('Detail scroll end marker'),
            'mouse wheel must reveal the end of long detail'
          )
          child.stdin.write(`${JSON.stringify('\u001b')}\n`)
          checkpoint('dismissed')
          continue
        }
        if (check === 'dismissed') {
          assert.ok(!frame.includes('#2 Latest observation fixture'), 'Esc must dismiss detail')
          await writeFile(join(evidence, 'detail-dismissed.txt'), frame)
          phase = 'recollapsed'
          const rows = frame.split('\n')
          const row = rows.findIndex((text) => text.includes('Memory'))
          assert.ok(rows[row], 'sidebar must return after Esc')
          click = clickAt(rows[row], row)
          child.stdin.write(`${JSON.stringify(click)}\n`)
          continue
        } else if (phase === 'detail') {
          continue
        }
        const rows = frame.split('\n')
        const row = rows.findIndex((text) => text.includes('Memory'))
        const header = rows[row]
        const item = rows.findIndex((text) => text.includes('Latest observation fixture'))
        if (header && click) {
          // The layout can shift after a capture; aim retries at the target's current cell.
          click = clickAt(header, row)
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
              case 'recollapsed': {
                return
              }
              default: {
                throw new Error(`Unknown sidebar phase: ${phase satisfies never}`)
              }
            }
            if (phase === 'detail' && rows[item]) {
              detailAt = `${rows[item].indexOf('Latest observation fixture') + 3};${item + 1}`
              child.stdin.write(
                `${JSON.stringify(`\u001b[<35;${detailAt}M\u001b[<0;${detailAt}M`)}\n`
              )
              checkpoint('held')
              continue
            }
            click = clickAt(header, row)
            child.stdin.write(`${JSON.stringify(click)}\n`)
          }
        }
      }
    }
    throw new Error(`Terminal exited before ${phase} capture`)
  } finally {
    clearInterval(retry)
    clearTimeout(checkpointTimer)
    await writeFile(join(evidence, 'terminal.ansi'), ansi)
  }
}
