import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { z } from 'zod'

export interface InjectionOptions {
  readonly enabled: boolean
  readonly limit: number
  readonly maxChars: number
  readonly timeoutMs: number
}
export interface MemoryOptions {
  readonly semanticInjection: InjectionOptions
  readonly fileContext: InjectionOptions
}

const group = z
  .object({
    enabled: z.boolean().optional().catch(undefined),
    limit: z.number().int().min(1).max(50).optional().catch(undefined),
    maxChars: z.number().int().min(256).max(24000).optional().catch(undefined),
    timeoutMs: z.number().int().min(100).max(10000).optional().catch(undefined),
  })
  .catch({})
const optionsSchema = z
  .object({
    semanticInjection: group.optional(),
    fileContext: group.optional(),
  })
  .catch({})
const settingsSchema = z
  .object({
    CLAUDE_MEM_SEMANTIC_INJECT: z.unknown().optional(),
    CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: z.unknown().optional(),
  })
  .catch({})

function booleanSetting(value: unknown): boolean | undefined {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : value
  if (normalized === true || normalized === 'true' || normalized === '1') {
    return true
  }
  if (normalized === false || normalized === 'false' || normalized === '0') {
    return false
  }
  return undefined
}

function limitSetting(value: unknown): number | undefined {
  const parsed = z.coerce.number().int().min(1).max(50).safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export function parseMemoryOptions(
  options: unknown,
  env: Readonly<Record<string, string | undefined>>,
  settings: unknown
): MemoryOptions {
  const explicit = optionsSchema.parse(options)
  const stored = settingsSchema.parse(settings)
  return {
    semanticInjection: {
      enabled:
        explicit.semanticInjection?.enabled ??
        booleanSetting(env.CLAUDE_MEM_SEMANTIC_INJECT) ??
        booleanSetting(stored.CLAUDE_MEM_SEMANTIC_INJECT) ??
        false,
      limit:
        explicit.semanticInjection?.limit ??
        limitSetting(env.CLAUDE_MEM_SEMANTIC_INJECT_LIMIT) ??
        limitSetting(stored.CLAUDE_MEM_SEMANTIC_INJECT_LIMIT) ??
        5,
      maxChars: explicit.semanticInjection?.maxChars ?? 6000,
      timeoutMs: explicit.semanticInjection?.timeoutMs ?? 2000,
    },
    fileContext: {
      enabled: explicit.fileContext?.enabled ?? true,
      limit: explicit.fileContext?.limit ?? 15,
      maxChars: explicit.fileContext?.maxChars ?? 6000,
      timeoutMs: explicit.fileContext?.timeoutMs ?? 1500,
    },
  }
}

export function resolveMemoryOptions(options: unknown): MemoryOptions {
  let settings: unknown = {}
  try {
    settings = JSON.parse(readFileSync(join(homedir(), '.claude-mem', 'settings.json'), 'utf8'))
  } catch {
    // Optional user configuration is a fail-open boundary, never logged.
  }
  return parseMemoryOptions(options, process.env, settings)
}
