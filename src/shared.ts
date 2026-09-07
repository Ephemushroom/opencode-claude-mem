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

export function stripTaggedContent(text: string): string {
  let result = ''
  let offset = 0
  const stack: string[] = []
  for (const match of text.matchAll(/<(\/?)(private|claude-mem-context)\b[^>]*>/gi)) {
    if (stack.length === 0) {
      result += text.slice(offset, match.index)
    }
    const name = match[2].toLowerCase()
    if (match[1] === '/') {
      if (stack.at(-1) === name) {
        stack.pop()
      }
    } else {
      stack.push(name)
    }
    offset = match.index + match[0].length
  }
  // An unmatched opening tag protects the rest of the payload, not just a pair.
  if (stack.length === 0) {
    result += text.slice(offset)
  }
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

  const normalizedName = toolName.toLowerCase().replaceAll('_', '-')
  // Skip Claude-Mem's own MCP search tools regardless of the user-chosen MCP
  // server name (prefix varies: `claude-mem_mcp-search_`, `mem_...`, etc.)
  if (
    normalizedName.includes('mcp-search') ||
    /(?:^|[-.])mem-(?:save|search|timeline|get-observations)$/.test(normalizedName)
  ) {
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
