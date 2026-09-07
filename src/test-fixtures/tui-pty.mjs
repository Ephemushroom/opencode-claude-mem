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
child.onData((data) => {
  terminal.write(data, () => {
    const lines = []
    for (let row = 0; row < terminal.rows; row++) {
      lines.push(terminal.buffer.active.getLine(row)?.translateToString(true) ?? '')
    }
    process.stdout.write(`${JSON.stringify({ frame: lines.join('\n'), ansi: data })}\n`)
  })
})
createInterface({ input: process.stdin }).on('line', (line) => child.write(JSON.parse(line)))
child.onExit(({ exitCode }) => {
  terminal.dispose()
  process.exit(exitCode)
})
