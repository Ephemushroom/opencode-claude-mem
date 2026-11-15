import { createInterface } from 'node:readline'
import { createRequire } from 'node:module'

const require = createRequire(process.env.TUI_FIXTURE_TOOLS)
const { spawn } = require('node-pty')
const { Terminal } = require('@xterm/headless')
const terminal = new Terminal({ cols: 140, rows: 40, allowProposedApi: true })
const child = spawn(process.argv[2], process.argv.slice(3), {
  name: 'xterm-256color',
  cols: 140,
  rows: 40,
  cwd: process.cwd(),
  env: process.env,
})
terminal.onData((data) => child.write(data))
function snapshot(ansi, checkpoint) {
  const lines = []
  const backgrounds = []
  for (let row = 0; row < terminal.rows; row++) {
    const line = terminal.buffer.active.getLine(row)
    lines.push(line?.translateToString(true) ?? '')
    backgrounds.push(
      Array.from({ length: terminal.cols }, (_, column) => {
        const cell = line?.getCell(column)
        return `${cell?.getBgColorMode()}:${cell?.getBgColor()}`
      })
    )
  }
  process.stdout.write(
    `${JSON.stringify({ frame: lines.join('\n'), ansi, backgrounds, checkpoint })}\n`
  )
}
child.onData((data) => {
  terminal.write(data, () => {
    snapshot(data)
  })
})
createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  if (typeof command === 'string') {
    child.write(command)
  } else {
    terminal.write('', () => snapshot('', command.checkpoint))
  }
})
child.onExit(({ exitCode }) => {
  terminal.dispose()
  process.exit(exitCode)
})
