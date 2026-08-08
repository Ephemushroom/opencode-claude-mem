export const MAX_OBSERVATION_BYTES = 24 * 1024
export const MAX_TAG_REPLACEMENTS = 100

export const META_TOOLS = new Set([
  'askuserquestion',
  'getmcpresource',
  'listmcpresourcestool',
  'listmcptools',
  'mem-get-observations',
  'mem-search',
  'mem-timeline',
  'skill',
  'slashcommand',
  'todowrite',
])

const PRIVATE_TAG_REGEX = /<private>[\s\S]*?<\/private>/g
const CONTEXT_TAG_REGEX = /<claude-mem-context>[\s\S]*?<\/claude-mem-context>/g

export function stripTaggedContent(text: string): string {
  if (!text) {
    return text
  }

  let result = text
  let replacements = 0

  while (replacements < MAX_TAG_REPLACEMENTS && PRIVATE_TAG_REGEX.test(result)) {
    PRIVATE_TAG_REGEX.lastIndex = 0
    result = result.replace(PRIVATE_TAG_REGEX, '')
    replacements++
  }
  PRIVATE_TAG_REGEX.lastIndex = 0

  while (replacements < MAX_TAG_REPLACEMENTS && CONTEXT_TAG_REGEX.test(result)) {
    CONTEXT_TAG_REGEX.lastIndex = 0
    result = result.replace(CONTEXT_TAG_REGEX, '')
    replacements++
  }
  CONTEXT_TAG_REGEX.lastIndex = 0

  return result.trim()
}

export function sanitizeObservationValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return stripTaggedContent(value)
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeObservationValue(item))
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeObservationValue(item)])
    )
  }

  return value
}

export function truncateUtf8Bytes(text: string, maxBytes: number): string {
  const encoder = new TextEncoder()
  if (encoder.encode(text).length <= maxBytes) {
    return text
  }

  const suffix = '\n[truncated]'
  const suffixBytes = encoder.encode(suffix).length
  const budget = Math.max(maxBytes - suffixBytes, 0)

  let low = 0
  let high = text.length

  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    const candidate = text.slice(0, mid)
    if (encoder.encode(candidate).length <= budget) {
      low = mid
    } else {
      high = mid - 1
    }
  }

  return `${text.slice(0, low)}${suffix}`
}

export function shouldSkipObservationTool(toolName: string): boolean {
  if (!toolName) {
    return true
  }

  const normalizedName = toolName.toLowerCase()
  // Skip Claude-Mem's own MCP search tools regardless of the user-chosen MCP
  // server name (prefix varies: `claude-mem_mcp-search_`, `mem_...`, etc.)
  if (normalizedName.includes('mcp-search') || normalizedName.includes('mem-search')) {
    return true
  }
  return META_TOOLS.has(normalizedName)
}

export function normalizeToolOutput(output: unknown): string {
  if (typeof output === 'string') {
    return output
  }

  if (output === undefined || output === null) {
    return ''
  }

  try {
    return JSON.stringify(output)
  } catch {
    return String(output)
  }
}

/**
 * Extract text content from message parts.
 * Parts can be TextPart, ToolCallPart, etc. We only want text.
 * Skips synthetic/ignored parts to match what is shown to the user.
 */
export function extractTextFromParts(parts: any[]): string {
  if (!parts || !Array.isArray(parts)) {
    return ''
  }
  return parts
    .filter(
      (p: any) => p && p.type === 'text' && typeof p.text === 'string' && !p.synthetic && !p.ignored
    )
    .map((p: any) => p.text)
    .join('\n')
    .trim()
}
