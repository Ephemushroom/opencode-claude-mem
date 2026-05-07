import { type Plugin, type PluginModule } from '@opencode-ai/plugin'
import { WorkerClient } from './worker-client'

const MAX_OBSERVATION_BYTES = 24 * 1024
const MAX_TAG_REPLACEMENTS = 100
const ASSISTANT_FLUSH_DEBOUNCE_MS = 250
const META_TOOLS = new Set([
  'askuserquestion',
  'getmcpresource',
  'listmcpresourcestool',
  'listmcptools',
  'skill',
  'slashcommand',
  'todowrite',
])
const PRIVATE_TAG_REGEX = /<private>[\s\S]*?<\/private>/g
const CONTEXT_TAG_REGEX = /<claude-mem-context>[\s\S]*?<\/claude-mem-context>/g

function stripTaggedContent(text: string): string {
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

function sanitizeObservationValue(value: unknown): unknown {
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

function truncateUtf8Bytes(text: string, maxBytes: number): string {
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

function shouldSkipObservationTool(toolName: string): boolean {
  if (!toolName) {
    return true
  }

  const normalizedName = toolName.toLowerCase()
  return normalizedName.startsWith('claude-mem_mcp-search_') || META_TOOLS.has(normalizedName)
}

function normalizeToolOutput(output: unknown): string {
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
function extractTextFromParts(parts: any[]): string {
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

/**
 * OpenCode Plugin for Claude-Mem
 *
 * Hooks used:
 * - `event` — session lifecycle (session.created, session.idle, session.compacted,
 *             session.deleted, message.updated, file.edited)
 * - `tool.execute.after` — capture tool observations
 * - `experimental.chat.system.transform` — inject memory context into system prompt
 * - `experimental.session.compacting` — preserve memory context during compaction
 * - `chat.message` — session init with real user prompt
 *
 * Memory context is automatically injected into every conversation via system prompt.
 * No manual commands needed - the plugin works transparently in the background.
 */
export const ClaudeMemPlugin: Plugin = async (ctx) => {
  const { project, directory, client } = ctx

  const projectRoot = directory || process.cwd()
  const projectName = project?.worktree
    ? project.worktree.split(/[\\/]/).findLast(Boolean) || 'unknown-project'
    : 'unknown-project'

  /** Show a toast notification in the TUI (best effort, never throws) */
  async function toast(
    message: string,
    variant: 'info' | 'success' | 'warning' | 'error' = 'info',
    duration = 3000
  ) {
    try {
      await (client as any).tui.showToast({
        body: { title: 'Claude-Mem', message, variant, duration },
      })
    } catch {
      // TUI not available or API changed — ignore
    }
  }

  // Session-level context cache — fetched once per session, like Claude Code's SessionStart
  let contextCache: string | null | undefined = undefined

  /** Fetch context once per session (cached after first call) */
  async function getCachedContext(): Promise<string | null> {
    if (contextCache !== undefined) {
      return contextCache
    }
    const context = await WorkerClient.getContext(projectName)
    contextCache = context
    return context
  }

  // Worker health checked lazily — avoid calling client.tui during plugin init
  // (TUI may not be ready yet, causing OpenCode to crash on startup)
  let workerHealthy: boolean | null = null
  let initToastShown = false

  /**
   * Lazy worker health check + deferred init toast.
   *
   * If the worker is offline and `bun` is on PATH, we attempt to launch it
   * once via `bunx claude-mem start` (matches what `npx claude-mem install
   * --ide opencode` users would run manually). Result is cached so subsequent
   * calls are cheap.
   */
  async function checkWorkerAndToast(): Promise<boolean> {
    if (workerHealthy === null) {
      // First call — try to ensure the worker is actually running. If it
      // already is, this is a single cheap health check. If it isn't, this
      // spawns `bunx claude-mem start` once and waits up to ~8s for it to
      // report healthy.
      workerHealthy = await WorkerClient.ensureRunning()
    }
    if (!initToastShown) {
      initToastShown = true
      if (workerHealthy) {
        await toast(`Memory active · ${projectName}`, 'success')
      } else {
        await toast(
          'Worker offline — install Claude-Mem (bunx claude-mem start) or start Claude Code first',
          'warning',
          5000
        )
      }
    }
    return workerHealthy
  }

  let currentSessionId: string | null = null
  const initializedSessions = new Set<string>()

  /**
   * Per-session debounced assistant-message buffer.
   *
   * Why debounce: `message.updated` fires on every streaming chunk. Sending each
   * chunk to /api/sessions/observations would flood the worker with hundreds of
   * partial duplicates per turn. We hold the latest text in a buffer, schedule a
   * flush after `ASSISTANT_FLUSH_DEBOUNCE_MS` of quiet, and also flush on
   * session.idle / session.deleted to guarantee the final message lands.
   */
  interface AssistantBuffer {
    text: string
    messageId: string | null
    timer: ReturnType<typeof setTimeout> | null
  }
  const assistantBuffers = new Map<string, AssistantBuffer>()

  async function flushAssistantBuffer(sessionId: string): Promise<void> {
    const buf = assistantBuffers.get(sessionId)
    if (!buf || !buf.text) {
      return
    }
    if (buf.timer) {
      clearTimeout(buf.timer)
      buf.timer = null
    }

    const { text } = buf
    // Reset buffer text BEFORE awaiting so concurrent updates start fresh.
    buf.text = ''

    try {
      const sanitized = truncateUtf8Bytes(stripTaggedContent(text), MAX_OBSERVATION_BYTES)
      if (sanitized) {
        await WorkerClient.sendObservation(
          sessionId,
          'assistant_message',
          buf.messageId ? { messageId: buf.messageId } : {},
          sanitized,
          projectRoot
        )
      }
    } catch {
      // silently fail
    }
  }

  function scheduleAssistantFlush(sessionId: string): void {
    const buf = assistantBuffers.get(sessionId)
    if (!buf) {
      return
    }
    if (buf.timer) {
      clearTimeout(buf.timer)
    }
    buf.timer = setTimeout(() => {
      buf.timer = null
      void flushAssistantBuffer(sessionId)
    }, ASSISTANT_FLUSH_DEBOUNCE_MS)
  }

  function discardAssistantBuffer(sessionId: string): void {
    const buf = assistantBuffers.get(sessionId)
    if (buf?.timer) {
      clearTimeout(buf.timer)
    }
    assistantBuffers.delete(sessionId)
  }

  /**
   * Helper: ensure a session is initialized with the worker.
   * Idempotent — safe to call multiple times for the same session.
   * P2: Now accepts an optional prompt parameter (the actual user message).
   */
  async function ensureSessionInit(sessionId: string, prompt?: string): Promise<boolean> {
    if (initializedSessions.has(sessionId)) {
      return true
    }

    const isHealthy = await checkWorkerAndToast()
    if (!isHealthy) {
      return false
    }

    try {
      await WorkerClient.sessionInit(sessionId, projectName, prompt || 'SESSION_START')
      initializedSessions.add(sessionId)
      currentSessionId = sessionId
      return true
    } catch {
      return false
    }
  }

  /**
   * Fetch the latest text content for an assistant message from OpenCode.
   * Used by message.updated since the event payload only carries metadata.
   */
  async function fetchAssistantMessageText(sessionId: string, messageId: string): Promise<string> {
    try {
      const result = await client.session.messages({ path: { id: sessionId } })
      if (result.data && Array.isArray(result.data)) {
        const target = result.data.find((m: any) => m?.info?.id === messageId)
        if (target) {
          return extractTextFromParts(target.parts)
        }
      }
    } catch {
      // Ignore — caller treats empty string as "skip flush this round"
    }
    return ''
  }

  /**
   * Fetch the most recent user + assistant message texts for summarization.
   */
  async function fetchLastMessages(
    sessionId: string
  ): Promise<{ user: string; assistant: string }> {
    let user = ''
    let assistant = ''

    try {
      const result = await client.session.messages({ path: { id: sessionId } })
      if (result.data && Array.isArray(result.data)) {
        const messages = result.data
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].info.role === 'user') {
            user = extractTextFromParts(messages[i].parts)
            break
          }
        }
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].info.role === 'assistant') {
            assistant = extractTextFromParts(messages[i].parts)
            break
          }
        }
      }
    } catch {
      // ignore
    }

    return { user, assistant }
  }

  return {
    /**
     * Hook: Event
     * Handles session.created, session.idle, session.compacted, session.deleted,
     * message.updated (assistant), and file.edited.
     */
    event: async ({ event }: { event: any }) => {
      switch (event.type) {
        case 'session.created': {
          const sessionId = event.properties?.info?.id
          if (!sessionId) {
            return
          }
          // Do NOT call ensureSessionInit — that would use "SESSION_START" as prompt.
          // Let chat.message handle init with the real user prompt.
          currentSessionId = sessionId
          // Invalidate context cache so new session fetches fresh context
          // (includes summaries from previous sessions)
          contextCache = undefined
          await checkWorkerAndToast()
          return
        }

        case 'message.updated': {
          // Capture assistant message text as observation, debounced to avoid
          // flooding the worker with streaming chunks. Skips user/system messages.
          const info = event.properties?.info
          const sessionId = info?.sessionID
          const messageId = info?.id
          if (!sessionId || !messageId || info?.role !== 'assistant') {
            return
          }

          const isHealthy = await checkWorkerAndToast()
          if (!isHealthy) {
            return
          }
          if (!(await ensureSessionInit(sessionId))) {
            return
          }

          const text = await fetchAssistantMessageText(sessionId, messageId)
          if (!text) {
            return
          }

          let buf = assistantBuffers.get(sessionId)
          if (!buf) {
            buf = { text: '', messageId: null, timer: null }
            assistantBuffers.set(sessionId, buf)
          }
          buf.text = text
          buf.messageId = messageId
          scheduleAssistantFlush(sessionId)
          return
        }

        case 'file.edited': {
          // Forward file edits as standalone observations (mirrors the official
          // claude-mem opencode plugin). The OpenCode SDK does not include the
          // diff in the event payload, so we send the path only.
          const filePath = event.properties?.file
          const sessionId = currentSessionId
          if (!sessionId || !filePath) {
            return
          }
          const isHealthy = await checkWorkerAndToast()
          if (!isHealthy) {
            return
          }
          if (!(await ensureSessionInit(sessionId))) {
            return
          }

          try {
            await WorkerClient.sendObservation(
              sessionId,
              'file_edit',
              { path: filePath },
              `File edited: ${filePath}`,
              projectRoot
            )
          } catch {
            // silently fail
          }
          return
        }

        case 'session.compacted': {
          // OpenCode finished compacting — flush any pending assistant buffer
          // and trigger summarization of the latest user/assistant pair.
          const sessionId = event.properties?.sessionID || currentSessionId
          if (!sessionId) {
            return
          }
          await flushAssistantBuffer(sessionId)

          const isHealthy = await checkWorkerAndToast()
          if (!isHealthy) {
            return
          }

          try {
            const { user, assistant } = await fetchLastMessages(sessionId)
            await WorkerClient.summarize(sessionId, user, assistant)
          } catch {
            // silently fail
          }
          return
        }

        case 'session.idle': {
          const sessionId = event.properties?.sessionID || currentSessionId
          if (!sessionId) {
            return
          }
          await flushAssistantBuffer(sessionId)

          try {
            const { user, assistant } = await fetchLastMessages(sessionId)
            await WorkerClient.summarize(sessionId, user, assistant)
            await WorkerClient.completeSession(sessionId)
            await toast('Session summarized', 'success', 2000)
          } catch {
            // silently fail
          }
          return
        }

        case 'session.deleted': {
          // OpenCode removed the session. Flush any pending buffer, then tell
          // the worker so the sdk_sessions row is marked completed instead of
          // hanging in 'active' as a zombie (the root cause of queueDepth
          // accumulation seen in earlier worker logs).
          const sessionId = event.properties?.info?.id || currentSessionId
          if (!sessionId) {
            return
          }
          await flushAssistantBuffer(sessionId)
          discardAssistantBuffer(sessionId)
          initializedSessions.delete(sessionId)
          if (currentSessionId === sessionId) {
            currentSessionId = null
          }

          try {
            await WorkerClient.completeSession(sessionId)
          } catch {
            // silently fail
          }
          return
        }

        default: {
          return
        }
      }
    },

    /**
     * Hook: Chat Message
     * Session initialization with real user prompt.
     */
    'chat.message': async (input, output) => {
      const sessionId = input.sessionID
      if (sessionId) {
        const userPrompt = extractTextFromParts(output.parts)
        await ensureSessionInit(sessionId, userPrompt || undefined)
      }
    },

    /**
     * Hook: Inject memory context into system prompt
     * P0: Uses /api/context/inject for rich pre-formatted context instead of /api/search.
     */
    'experimental.chat.system.transform': async (input, output) => {
      const sessionId = (input as any).sessionID

      // Try to init session if we haven't yet
      if (sessionId) {
        await ensureSessionInit(sessionId)
      }

      const isHealthy = await checkWorkerAndToast()
      if (!isHealthy) {
        return
      }

      try {
        const context = await getCachedContext()
        if (context) {
          output.system.push(
            `<claude-mem-context>\n[Claude-Mem] Memory Active. Previous Context:\n${context}\n</claude-mem-context>`
          )
        }
      } catch {
        // silently fail
      }
    },

    /**
     * Hook: Preserve memory context during compaction
     */
    'experimental.session.compacting': async (input, output) => {
      const sessionId = (input as any).sessionID

      if (sessionId) {
        await ensureSessionInit(sessionId)
      }

      const isHealthy = await checkWorkerAndToast()
      if (!isHealthy) {
        return
      }

      try {
        const context = await getCachedContext()
        if (context) {
          output.context.push(
            `<claude-mem-context>\n[Claude-Mem] Memory Active. Previous Context:\n${context}\n</claude-mem-context>`
          )
        }
      } catch {
        // silently fail
      }
    },

    /**
     * Hook: Tool Execution After
     * Captures tool observations. SDK provides args directly in input.
     */
    'tool.execute.after': async (input, output) => {
      const sessionId = input.sessionID || currentSessionId
      if (!sessionId) {
        return
      }

      if (shouldSkipObservationTool(input.tool)) {
        return
      }

      // Ensure session is initialized before sending observations
      await ensureSessionInit(sessionId)

      try {
        const sanitizedToolInput = sanitizeObservationValue(input.args || {})
        const sanitizedToolOutput = truncateUtf8Bytes(
          stripTaggedContent(normalizeToolOutput(output.output)),
          MAX_OBSERVATION_BYTES
        )

        await WorkerClient.sendObservation(
          sessionId,
          input.tool,
          sanitizedToolInput,
          sanitizedToolOutput,
          projectRoot
        )
      } catch {
        // Silently fail - don't block tool execution
      }
    },
  }
}

export default { server: ClaudeMemPlugin } satisfies PluginModule
