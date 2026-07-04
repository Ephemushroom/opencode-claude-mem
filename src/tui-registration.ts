import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PACKAGE_NAME = '@ephemushroom/opencode-claude-mem'

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

function isOwnEntry(entry: string): boolean {
  return entry === PACKAGE_NAME || entry.startsWith(`${PACKAGE_NAME}@`)
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
