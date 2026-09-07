import {
  MAX_OBSERVATION_BYTES,
  extractTextFromParts,
  normalizeToolOutput,
  sanitizeObservationValue,
  shouldSkipObservationTool,
  stripTaggedContent,
  truncateUtf8Bytes,
} from './shared'
import { type Plugin, type PluginModule, tool } from '@opencode-ai/plugin'
import { memoryTurn, resumedV1Turn } from './memory-turn'
import { FileContext } from './file-context'
import { MemorySessions } from './memory-session'
import { MemoryWorker } from './memory-worker'
import { WorkerClient } from './worker-client'
import { ensureTuiPluginEntry } from './tui-registration'
import { resolveMemoryOptions } from './memory-options'

const ASSISTANT_FLUSH_DEBOUNCE_MS = 250

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
export const ClaudeMemPlugin: Plugin = async (ctx, options) => {
  const { project, directory, client } = ctx
  const config = resolveMemoryOptions(options)
  const memory = new MemorySessions(config)
  const files = new FileContext(config.fileContext)
  const resumed = new Map<string, Promise<void>>()
  const subagentSessions = new Set<string>()

  ensureTuiPluginEntry()

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

  // Worker health checked lazily — avoid calling client.tui during plugin init
  // (TUI may not be ready yet, causing OpenCode to crash on startup)
  let workerHealthy: boolean | null = null
  let initToastShown = false

  /**
   * Lazy worker health check + deferred init toast.
   *
   * If the worker is offline and `bun` is on PATH, we attempt to launch it
   * once via `bunx claude-mem start` (matches what `npx claude-mem install
   * --ide opencode` users would run manually). Startup is once-only, but health
   * is checked again so a later recovery is observable.
   */
  async function checkWorkerAndToast(): Promise<boolean> {
    const previousHealth = workerHealthy
    workerHealthy = await WorkerClient.ensureRunning()
    if (!initToastShown || previousHealth !== workerHealthy) {
      initToastShown = true
      await toast(
        workerHealthy
          ? `Memory active · ${projectName}`
          : 'Worker offline — install Claude-Mem (bunx claude-mem start) or start Claude Code first',
        workerHealthy ? 'success' : 'warning',
        workerHealthy ? 3000 : 5000
      )
    }
    return workerHealthy
  }

  let currentSessionId: string | null = null

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
    messageId: string | null
    timer: ReturnType<typeof setTimeout> | null
  }
  const assistantBuffers = new Map<string, AssistantBuffer>()
  const assistantFlushes = new Map<string, Promise<void>>()

  async function flushAssistantBuffer(sessionId: string): Promise<void> {
    const existing = assistantFlushes.get(sessionId)
    if (existing) {
      await existing
    }
    if (!memory.canCapture(sessionId)) {
      discardAssistantBuffer(sessionId)
      return
    }
    const buf = assistantBuffers.get(sessionId)
    if (!buf || !buf.messageId) {
      return
    }
    if (buf.timer) {
      clearTimeout(buf.timer)
      buf.timer = null
    }

    const { messageId } = buf
    // Reset BEFORE awaiting so concurrent updates start fresh.
    buf.messageId = null

    const pending = (async () => {
      try {
        const text = await fetchAssistantMessageText(sessionId, messageId)
        const sanitized = truncateUtf8Bytes(stripTaggedContent(text), MAX_OBSERVATION_BYTES)
        if (sanitized) {
          await WorkerClient.sendObservation(
            sessionId,
            'assistant_message',
            { messageId },
            sanitized,
            projectRoot
          )
        }
      } catch {
        // silently fail
      }
    })()
    assistantFlushes.set(sessionId, pending)
    try {
      await pending
    } finally {
      if (assistantFlushes.get(sessionId) === pending) {
        assistantFlushes.delete(sessionId)
      }
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
  async function ensureSessionInit(sessionId: string): Promise<boolean> {
    if (memory.isDeleted(sessionId)) {
      return false
    }
    try {
      if (!memory.hasTurn(sessionId)) {
        let pending = resumed.get(sessionId)
        if (!pending) {
          pending = (async () => {
            const result = await client.session.messages({ path: { id: sessionId } })
            const turn = resumedV1Turn(result.data)
            if (turn && !memory.hasTurn(sessionId) && resumed.has(sessionId)) {
              memory.select(sessionId, turn)
            }
          })()
          resumed.set(sessionId, pending)
        }
        await pending
        if (!memory.hasTurn(sessionId)) {
          resumed.delete(sessionId)
        }
      }
      if (!memory.hasTurn(sessionId) || !(await checkWorkerAndToast())) {
        return false
      }
      return await memory.register(sessionId, projectName)
    } catch {
      resumed.delete(sessionId)
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
  ): Promise<{ user: string; assistant: string; observedModel?: string }> {
    let user = ''
    let assistant = ''
    let observedModel: string | undefined = undefined

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
          const { info } = messages[i]
          if (info.role === 'assistant') {
            assistant = extractTextFromParts(messages[i].parts)
            observedModel = info.modelID
            break
          }
        }
      }
    } catch {
      // ignore
    }

    return { user, assistant, observedModel }
  }

  return {
    tool: {
      'mem-save': tool({
        description:
          'Save an explicit memory to Claude-Mem. Private and injected context are removed. Check an uncertain result before retrying.',
        args: {
          text: tool.schema.string().min(1).max(MAX_OBSERVATION_BYTES),
          title: tool.schema.string().max(MAX_OBSERVATION_BYTES).optional(),
          project: tool.schema.string().min(1).optional(),
        },
        execute: async (input) => MemoryWorker.save(input, projectName),
      }),
      'mem-search': tool({
        description:
          'Search Claude-Mem persistent memory. Supports query, project, platformSource, type, obs_type, dateStart, dateEnd, offset, and orderBy filters.',
        args: {
          query: tool.schema
            .string()
            .min(1)
            .optional()
            .describe('Optional semantic search query for Claude-Mem memory'),
          limit: tool.schema
            .number()
            .int()
            .positive()
            .max(100)
            .optional()
            .describe('Maximum number of search results (default 20)'),
          project: tool.schema.string().min(1).optional().describe('Filter by project name'),
          platformSource: tool.schema
            .string()
            .min(1)
            .optional()
            .describe('Filter by platform source, such as claude or opencode'),
          type: tool.schema.string().min(1).optional().describe('Filter by result type'),
          obs_type: tool.schema
            .string()
            .min(1)
            .optional()
            .describe('Filter by observation type, such as feature or bugfix'),
          dateStart: tool.schema
            .string()
            .min(1)
            .optional()
            .describe('Start date filter in ISO 8601 or YYYY-MM-DD format'),
          dateEnd: tool.schema
            .string()
            .min(1)
            .optional()
            .describe('End date filter in ISO 8601 or YYYY-MM-DD format'),
          offset: tool.schema.number().int().min(0).optional().describe('Pagination offset'),
          orderBy: tool.schema
            .enum(['date_desc', 'date_asc', 'relevance'])
            .optional()
            .describe('Sort order'),
        },
        execute: async ({
          query,
          limit,
          project: projectFilter,
          platformSource,
          type,
          obs_type,
          dateStart,
          dateEnd,
          offset,
          orderBy,
        }) => {
          const isHealthy = await checkWorkerAndToast()
          if (!isHealthy) {
            return 'Claude-Mem worker is offline. Start Claude-Mem and retry the search.'
          }

          const result = await WorkerClient.search({
            query,
            limit,
            project: projectFilter ?? projectName,
            platformSource,
            type,
            obs_type,
            dateStart,
            dateEnd,
            offset,
            orderBy,
          })
          return result || `No Claude-Mem results found${query ? ` for "${query}"` : ''}.`
        },
      }),
      'mem-timeline': tool({
        description:
          'Get chronological Claude-Mem context around an observation. Use after mem-search: pass an observation ID as anchor (or a query to find the anchor automatically) to see what happened before/after.',
        args: {
          anchor: tool.schema
            .number()
            .int()
            .positive()
            .optional()
            .describe('Observation ID to center the timeline around'),
          query: tool.schema
            .string()
            .min(1)
            .optional()
            .describe('Query to locate the anchor automatically (used when anchor is omitted)'),
          depth_before: tool.schema
            .number()
            .int()
            .min(0)
            .max(20)
            .optional()
            .describe('Items before the anchor (default 3)'),
          depth_after: tool.schema
            .number()
            .int()
            .min(0)
            .max(20)
            .optional()
            .describe('Items after the anchor (default 3)'),
        },
        execute: async ({ anchor, query, depth_before, depth_after }) => {
          if (anchor === undefined && !query) {
            return 'Provide either an anchor observation ID or a query.'
          }
          const isHealthy = await checkWorkerAndToast()
          if (!isHealthy) {
            return 'Claude-Mem worker is offline. Start Claude-Mem and retry.'
          }

          const result = await WorkerClient.timeline({
            project: projectName,
            anchor,
            query,
            depthBefore: depth_before,
            depthAfter: depth_after,
          })
          return result || 'No Claude-Mem timeline results found.'
        },
      }),
      'mem-get-observations': tool({
        description:
          'Fetch full Claude-Mem observation details by ID. Use for IDs shown in the injected memory context or returned by mem-search/mem-timeline.',
        args: {
          ids: tool.schema
            .array(tool.schema.number().int().positive())
            .min(1)
            .max(50)
            .describe('Observation IDs to fetch'),
        },
        execute: async ({ ids }) => {
          const isHealthy = await checkWorkerAndToast()
          if (!isHealthy) {
            return 'Claude-Mem worker is offline. Start Claude-Mem and retry.'
          }

          const result = await WorkerClient.getObservations(ids, projectName)
          return result || `No Claude-Mem observations found for IDs [${ids.join(', ')}].`
        },
      }),
    },

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
          if (event.properties?.info?.parentID) {
            subagentSessions.add(sessionId)
          }
          // Invalidate context cache so new session fetches fresh context
          // (includes summaries from previous sessions)
          memory.invalidate(sessionId)
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

          let buf = assistantBuffers.get(sessionId)
          if (!buf) {
            buf = { messageId: null, timer: null }
            assistantBuffers.set(sessionId, buf)
          }
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
          memory.invalidate(sessionId)
          await flushAssistantBuffer(sessionId)
          if (!(await ensureSessionInit(sessionId))) {
            return
          }

          const isHealthy = await checkWorkerAndToast()
          if (!isHealthy) {
            return
          }

          try {
            const { user, assistant, observedModel } = await fetchLastMessages(sessionId)
            await WorkerClient.summarize(sessionId, user, assistant, { observedModel })
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
          if (!(await ensureSessionInit(sessionId))) {
            return
          }

          try {
            const { user, assistant, observedModel } = await fetchLastMessages(sessionId)
            if (await WorkerClient.summarize(sessionId, user, assistant, { observedModel })) {
              await toast('Session summary queued', 'success', 2000)
            }
          } catch {
            // silently fail
          }
          return
        }

        case 'session.deleted': {
          // Flush local buffers and release tracking. The worker self-completes;
          // externally completing it would discard pending observations.
          const sessionId = event.properties?.info?.id || currentSessionId
          if (!sessionId) {
            return
          }
          await flushAssistantBuffer(sessionId)
          discardAssistantBuffer(sessionId)
          memory.delete(sessionId)
          files.delete(sessionId)
          resumed.delete(sessionId)
          subagentSessions.delete(sessionId)
          if (currentSessionId === sessionId) {
            currentSessionId = null
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
        const id = input.messageID ?? output.message.id
        if (!id) {
          return
        }
        if (!memory.hasMessage(sessionId, id)) {
          // Finish the old turn before advancing the Worker's prompt number.
          await flushAssistantBuffer(sessionId)
        }
        currentSessionId = sessionId
        memory.select(
          sessionId,
          memoryTurn(
            id,
            userPrompt,
            output.parts.some((part) => part.type === 'file')
          )
        )
        await ensureSessionInit(sessionId)
      }
    },

    /**
     * Hook: Inject memory context into system prompt
     * P0: Uses /api/context/inject for rich pre-formatted context instead of /api/search.
     */
    'experimental.chat.system.transform': async (input, output) => {
      const sessionId = input.sessionID ?? currentSessionId
      if (!sessionId) {
        return
      }

      // Try to init session if we haven't yet
      if (sessionId) {
        await ensureSessionInit(sessionId)
      }

      const isHealthy = await checkWorkerAndToast()
      if (!isHealthy) {
        return
      }

      try {
        const base = await memory.context(sessionId, projectName)
        const semantic = await memory.semantic(sessionId, projectName)
        const context = [base, semantic].filter(Boolean).join('\n\n')
        for (let i = output.system.length - 1; i >= 0; i--) {
          if (output.system[i].startsWith('<claude-mem-context>')) {
            output.system.splice(i, 1)
          }
        }
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
      const sessionId = input.sessionID
      memory.invalidate(sessionId)

      if (sessionId) {
        await ensureSessionInit(sessionId)
      }

      const isHealthy = await checkWorkerAndToast()
      if (!isHealthy) {
        return
      }

      try {
        const context = await memory.context(sessionId, projectName)
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
      if (!(await ensureSessionInit(sessionId))) {
        return
      }

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
          projectRoot,
          input.callID
        )
        const history = subagentSessions.has(sessionId)
          ? ''
          : await files.read(
              sessionId,
              { tool: input.tool, args: input.args },
              { directory: projectRoot, project: projectName }
            )
        output.output += history
      } catch {
        // Silently fail - don't block tool execution
      }
    },
  }
}

export default { server: ClaudeMemPlugin } satisfies PluginModule
