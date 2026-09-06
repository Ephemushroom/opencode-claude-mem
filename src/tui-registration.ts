import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PACKAGE_NAME = '@ephemushroom/opencode-claude-mem'
const SIDEBAR_ENTRIES = [PACKAGE_NAME, `${PACKAGE_NAME}/cli`, `${PACKAGE_NAME}/tui`] as const

export type TuiRegistrationResult =
  | 'added'
  | 'already-present'
  | 'no-server-entry'
  | 'malformed'
  | 'failed'

function getConfigDir(): string {
  const custom = process.env['OPENCODE_CONFIG_DIR']?.trim()
  return custom || join(homedir(), '.config', 'opencode')
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function pluginEntries(config: Record<string, unknown>): string[] {
  const { plugin } = config
  if (!Array.isArray(plugin)) {
    return []
  }
  return plugin.filter((entry): entry is string => typeof entry === 'string')
}

type CliEntry = string | { readonly package: string; readonly options?: Record<string, unknown> }

function isCliEntry(entry: unknown): entry is CliEntry {
  if (typeof entry === 'string') {
    return true
  }
  if (typeof entry !== 'object' || entry === null || !('package' in entry)) {
    return false
  }
  return (
    typeof entry.package === 'string' &&
    (!('options' in entry) ||
      (typeof entry.options === 'object' &&
        entry.options !== null &&
        !Array.isArray(entry.options)))
  )
}

function v2PluginEntries(config: Record<string, unknown>): CliEntry[] | null {
  const { plugins } = config
  if (plugins === undefined) {
    return []
  }
  return Array.isArray(plugins) && plugins.every(isCliEntry) ? plugins : null
}

function isOwnEntry(entry: string): boolean {
  return (
    entry === PACKAGE_NAME ||
    entry.startsWith(`${PACKAGE_NAME}@`) ||
    entry.startsWith(`${PACKAGE_NAME}/`)
  )
}

function findServerEntry(configDir: string): string | null {
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    const filePath = join(configDir, name)
    const config = existsSync(filePath) ? readJson(filePath) : null
    const entry = config ? pluginEntries(config).find(isOwnEntry) : undefined
    if (entry) {
      return entry
    }
  }
  return null
}

/**
 * Self-heal ~/.config/opencode/tui.json: if this plugin is registered as an
 * OpenCode server plugin but missing from the TUI plugin list, append it so
 * the Memory sidebar loads without manual config. Uses writeFileSync (not
 * atomic rename) so a symlinked tui.json keeps pointing at its dotfiles
 * target instead of being replaced by a regular file.
 */
export function ensureTuiPluginEntry(): TuiRegistrationResult {
  try {
    const configDir = getConfigDir()
    const serverEntry = findServerEntry(configDir)
    if (!serverEntry) {
      return 'no-server-entry'
    }

    const tuiJsonPath = join(configDir, 'tui.json')
    let config: Record<string, unknown> = {}
    if (existsSync(tuiJsonPath)) {
      const parsed = readJson(tuiJsonPath)
      if (!parsed) {
        return 'malformed'
      }
      config = parsed
    }

    const plugins = pluginEntries(config)
    if (plugins.some(isOwnEntry)) {
      return 'already-present'
    }

    mkdirSync(configDir, { recursive: true })
    const next = { ...config, plugin: [...plugins, serverEntry] }
    writeFileSync(tuiJsonPath, `${JSON.stringify(next, null, 2)}\n`)
    return 'added'
  } catch {
    return 'failed'
  }
}

/**
 * V2 self-heal: register the V2 CLI entry in `~/.config/opencode/cli.json`
 * (the V2 CLI/TUI config file) so the Memory sidebar loads in the V2 TUI
 * without manual configuration. The CLI writes strict JSON (2-space indent),
 * so a comment-bearing file is left untouched ('malformed').
 */
export function ensureCliPluginEntry(): TuiRegistrationResult {
  try {
    const configDir = getConfigDir()
    const cliJsonPath = join(configDir, 'cli.json')
    let config: Record<string, unknown> = {}
    if (existsSync(cliJsonPath)) {
      const parsed = readJson(cliJsonPath)
      if (!parsed) {
        return 'malformed'
      }
      config = parsed
    }

    const plugins = v2PluginEntries(config)
    if (!plugins) {
      return 'malformed'
    }
    if (
      plugins.some((entry) => {
        const specifier = typeof entry === 'string' ? entry : entry.package
        return SIDEBAR_ENTRIES.some(
          (name) => specifier === name || specifier.startsWith(`${name}@`)
        )
      })
    ) {
      return 'already-present'
    }

    mkdirSync(configDir, { recursive: true })
    const next = { ...config, plugins: [...plugins, PACKAGE_NAME] }
    writeFileSync(cliJsonPath, `${JSON.stringify(next, null, 2)}\n`)
    return 'added'
  } catch {
    return 'failed'
  }
}
