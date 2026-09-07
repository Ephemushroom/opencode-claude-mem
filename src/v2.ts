import { type Context, define } from '@opencode-ai/plugin-v2/promise/plugin'
import {
  MAX_OBSERVATION_BYTES,
  extractTextFromParts,
  normalizeToolOutput,
  sanitizeObservationValue,
  shouldSkipObservationTool,
  stripTaggedContent,
  truncateUtf8Bytes,
} from './shared'
import { FileContext } from './file-context'
import { MemorySessions } from './memory-session'
import { MemoryWorker } from './memory-worker'
import { WorkerClient } from './worker-client'
import { deliveredTurn } from './memory-turn'
import { ensureCliPluginEntry } from './tui-registration'
import { resolveMemoryOptions } from './memory-options'

const EVENT_RETRY_DELAY_MS = 10_000
type StreamEvent =
  ReturnType<Context['event']['subscribe']> extends AsyncIterable<infer E> ? E : never

/**
 * OpenCode V2 plugin for Claude-Mem.
 *
 * V2 is a breaking API change from V1 — plugins are `Plugin.define({ id,
 * setup })` modules with a server-like context instead of a `{ server }`
 * module of hook handlers. This entrypoint is published under the package's
 * `./v2` export; V1 users keep loading the default export (see src/index.ts).
 * Both entrypoints are thin adapters over the same WorkerClient + shared
 * helpers, so V1 and V2 can coexist and talk to the same Claude-Mem worker.
 *
 * V2 API mapping (vs V1):
 * - `experimental.chat.system.transform` → `ctx.session.hook('context')` (push
 *   a SystemPart into `event.system`)
 * - `tool.execute.after` → `ctx.tool.hook('execute.after')`
 * - `tool` definitions → `ctx.tool.transform((tools) => tools.add(...))`
 * - `event` lifecycle → `ctx.event.subscribe()` stream
 * - Assistant text capture uses `session.text.ended` events (the event carries
 *   the complete text — no debounced re-fetch needed like V1's message.updated)
 * - Summarization fires on `session.execution.succeeded` (V1's session.idle)
 */
export default define({
  id: 'claude-mem',
  setup: async (ctx) => {
    // Self-heal ~/.config/opencode/cli.json so the V2 Memory sidebar loads
    // without manual configuration (mirrors the V1 tui.json self-heal).
    ensureCliPluginEntry()

    const controller = new AbortController()
    const config = resolveMemoryOptions(ctx.options)
    const memory = new MemorySessions(config)
    const files = new FileContext(config.fileContext)
    const admitted = new Map<string, Set<string>>()
    const compactions = new Map<string, string>()
    const subagentSessions = new Set<string>()
    const sessionDirs = new Map<string, string>()
    const sessionUserTexts = new Map<string, string>()
    const sessionAssistantTexts = new Map<string, string>()
    const sessionModels = new Map<string, string>()
    const defaultDirectory = ctx.location.directory

    async function checkWorker(): Promise<boolean> {
      return !controller.signal.aborted && (await WorkerClient.ensureRunning())
    }

    async function loadSessionLocation(sessionId: string): Promise<boolean> {
      if (memory.isDeleted(sessionId)) {
        return false
      }
      if (sessionDirs.has(sessionId)) {
        return true
      }
      try {
        const session = await ctx.session.get({ sessionID: sessionId })
        // The event stream is server-wide; never capture another location's sessions.
        if (
          controller.signal.aborted ||
          memory.isDeleted(sessionId) ||
          session.location.directory !== defaultDirectory
        ) {
          return false
        }
        sessionDirs.set(sessionId, session.location.directory)
        if ('parentID' in session && session.parentID) {
          subagentSessions.add(sessionId)
        }
        return true
      } catch {
        return false
      }
    }

    function projectNameFromDirectory(directory: string): string {
      return directory.split(/[\\/]/).findLast(Boolean) || 'unknown-project'
    }

    function getProjectName(sessionId: string): string {
      return projectNameFromDirectory(sessionDirs.get(sessionId) || defaultDirectory)
    }

    /**
     * Idempotent session init with the worker (mirrors V1). Only marks the
     * session initialized when the worker actually persisted it.
     */
    async function ensureSessionInit(sessionId: string): Promise<boolean> {
      if (
        !memory.hasTurn(sessionId) ||
        !(await checkWorker()) ||
        !(await loadSessionLocation(sessionId))
      ) {
        return false
      }
      return memory.register(sessionId, getProjectName(sessionId))
    }

    async function sendObservation(
      sessionId: string,
      toolName: string,
      toolInput: unknown,
      toolResponse: unknown,
      toolUseId?: string
    ): Promise<void> {
      if (!(await ensureSessionInit(sessionId))) {
        return
      }
      try {
        await WorkerClient.sendObservation(
          sessionId,
          toolName,
          toolInput,
          toolResponse,
          sessionDirs.get(sessionId) || defaultDirectory,
          toolUseId
        )
      } catch {
        // silently fail
      }
    }

    /** Normalize a V2 Tool.Result ({ output?, content? }) to text. */
    function normalizeToolResult(result: unknown): string {
      if (typeof result === 'string') {
        return result
      }
      if (!result || typeof result !== 'object') {
        return normalizeToolOutput(result)
      }
      const content = 'content' in result ? result.content : undefined
      if (typeof content === 'string') {
        return content
      }
      if (Array.isArray(content)) {
        const text = extractTextFromParts(content)
        if (text) {
          return text
        }
      }
      if ('output' in result && result.output !== undefined) {
        return normalizeToolOutput(result.output)
      }
      return normalizeToolOutput(result)
    }

    /**
     * Hook: Session Context
     * Fires immediately before model dispatch. Initializes the session with
     * the real user prompt (from the message list) and injects the cached
     * memory context into the system parts.
     */
    await ctx.session.hook('prompt', (event) => {
      if (controller.signal.aborted || memory.isDeleted(event.sessionID)) {
        return
      }
      let ids = admitted.get(event.sessionID)
      if (!ids) {
        ids = new Set()
        admitted.set(event.sessionID, ids)
      }
      ids.add(event.messageID)
    })
    await ctx.session.hook('model.request', (event) => {
      if (event.kind === 'compaction') {
        memory.invalidate(event.sessionID)
      }
    })
    await ctx.session.hook('context', async (event) => {
      const sessionId = event.sessionID
      if (!sessionId) {
        return
      }
      if (!(await loadSessionLocation(sessionId))) {
        return
      }
      sessionModels.set(sessionId, event.model.id)
      try {
        // The prompt hook sees queued/admitted input, not consumption. Context
        // records distinguish real users from synthetic messages and retain IDs.
        const messages = await ctx.session.context({ sessionID: sessionId })
        if (controller.signal.aborted || !sessionDirs.has(sessionId)) {
          return
        }
        const compaction = messages.findLast((message) => message.type === 'compaction')
        if (compaction && compactions.get(sessionId) !== compaction.id) {
          compactions.set(sessionId, compaction.id)
          memory.invalidate(sessionId)
        }
        for (const message of messages) {
          if (admitted.get(sessionId)?.has(message.id)) {
            const consumed = deliveredTurn([message])
            if (consumed && memory.select(sessionId, consumed)) {
              sessionAssistantTexts.delete(sessionId)
            }
            admitted.get(sessionId)?.delete(message.id)
          }
        }
        const turn = deliveredTurn(messages)
        if (turn) {
          if (memory.select(sessionId, turn)) {
            sessionAssistantTexts.delete(sessionId)
          }
          sessionUserTexts.set(sessionId, turn.text)
        }
        await ensureSessionInit(sessionId)
        if (!(await checkWorker())) {
          return
        }
        const base = await memory.context(sessionId, getProjectName(sessionId))
        const semantic = await memory.semantic(sessionId, getProjectName(sessionId))
        const context = [base, semantic].filter(Boolean).join('\n\n')
        event.system = event.system.filter(
          (part) => part.type !== 'text' || !part.text.startsWith('<claude-mem-context>')
        )
        if (context) {
          event.system.push({
            type: 'text',
            text: `<claude-mem-context>\n[Claude-Mem] Memory Active. Previous Context:\n${context}\n</claude-mem-context>`,
          })
        }
      } catch {
        // silently fail — never break model dispatch
      }
    })

    /**
     * Hook: Tool Execution After
     * Captures tool observations. Skips Claude-Mem's own tools and meta tools.
     */
    await ctx.tool.hook('execute.after', async (event) => {
      const sessionId = event.sessionID
      if (!sessionId || shouldSkipObservationTool(event.tool)) {
        return
      }
      if (!(await checkWorker())) {
        return
      }

      const sanitizedInput = sanitizeObservationValue(event.input ?? {})
      const sanitizedOutput = truncateUtf8Bytes(
        stripTaggedContent(
          event.status === 'error'
            ? (event.error?.message ?? String(event.error ?? ''))
            : normalizeToolResult(event.result)
        ),
        MAX_OBSERVATION_BYTES
      )
      await sendObservation(sessionId, event.tool, sanitizedInput, sanitizedOutput, event.id)
      if (
        event.status === 'completed' &&
        memory.canCapture(sessionId) &&
        !subagentSessions.has(sessionId)
      ) {
        const history = await files.read(
          sessionId,
          { tool: event.tool, args: event.input },
          {
            directory: sessionDirs.get(sessionId) || defaultDirectory,
            project: getProjectName(sessionId),
          }
        )
        if (history) {
          if (typeof event.result.content === 'string') {
            event.result = { ...event.result, content: event.result.content + history }
          } else if (Array.isArray(event.result.content)) {
            event.result = {
              ...event.result,
              content: [...event.result.content, { type: 'text', text: history }],
            }
          }
        }
      }
    })

    /**
     * Custom memory tools. `codemode: false` exposes them directly to the
     * provider (default `codemode: true` would only expose them via `execute`).
     */
    await ctx.tool.transform((tools) => {
      tools.add({
        name: 'mem-save',
        description:
          'Save explicit memory to Claude-Mem. Private and injected context are removed. Check uncertain results before retrying.',
        input: {
          type: 'object',
          properties: {
            text: { type: 'string', minLength: 1, maxLength: MAX_OBSERVATION_BYTES },
            title: { type: 'string', maxLength: MAX_OBSERVATION_BYTES },
            project: { type: 'string', minLength: 1 },
          },
          required: ['text'],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input: unknown, toolContext) => ({
          content: await MemoryWorker.save(input, getProjectName(toolContext.sessionID)),
        }),
      })
      tools.add({
        name: 'mem-search',
        description:
          'Search Claude-Mem persistent memory. Supports query, project, platformSource, type, obs_type, dateStart, dateEnd, offset, and orderBy filters.',
        input: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Optional semantic search query for Claude-Mem memory',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
              description: 'Maximum number of search results (default 20)',
            },
            project: { type: 'string', description: 'Filter by project name' },
            platformSource: {
              type: 'string',
              description: 'Filter by platform source, such as claude or opencode',
            },
            type: { type: 'string', description: 'Filter by result type' },
            obs_type: {
              type: 'string',
              description: 'Filter by observation type, such as feature or bugfix',
            },
            dateStart: {
              type: 'string',
              description: 'Start date filter in ISO 8601 or YYYY-MM-DD format',
            },
            dateEnd: {
              type: 'string',
              description: 'End date filter in ISO 8601 or YYYY-MM-DD format',
            },
            offset: { type: 'integer', minimum: 0, description: 'Pagination offset' },
            orderBy: {
              type: 'string',
              enum: ['date_desc', 'date_asc', 'relevance'],
              description: 'Sort order',
            },
          },
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input: any, toolContext) => {
          const args = input ?? {}
          if (!(await checkWorker())) {
            return {
              content: 'Claude-Mem worker is offline. Start Claude-Mem and retry the search.',
            }
          }
          const result = await WorkerClient.search({
            query: args.query,
            limit: args.limit,
            project: args.project ?? getProjectName(toolContext.sessionID),
            platformSource: args.platformSource,
            type: args.type,
            obs_type: args.obs_type,
            dateStart: args.dateStart,
            dateEnd: args.dateEnd,
            offset: args.offset,
            orderBy: args.orderBy,
          })
          return {
            content:
              result || `No Claude-Mem results found${args.query ? ` for "${args.query}"` : ''}.`,
          }
        },
      })

      tools.add({
        name: 'mem-timeline',
        description:
          'Get chronological Claude-Mem context around an observation. Use after mem-search: pass an observation ID as anchor (or a query to find the anchor automatically) to see what happened before/after.',
        input: {
          type: 'object',
          properties: {
            anchor: {
              type: 'integer',
              minimum: 1,
              description: 'Observation ID to center the timeline around',
            },
            query: {
              type: 'string',
              description: 'Query to locate the anchor automatically (used when anchor is omitted)',
            },
            depth_before: {
              type: 'integer',
              minimum: 0,
              maximum: 20,
              description: 'Items before the anchor (default 3)',
            },
            depth_after: {
              type: 'integer',
              minimum: 0,
              maximum: 20,
              description: 'Items after the anchor (default 3)',
            },
          },
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input: any, toolContext) => {
          const args = input ?? {}
          if (args.anchor === undefined && !args.query) {
            return { content: 'Provide either an anchor observation ID or a query.' }
          }
          if (!(await checkWorker())) {
            return { content: 'Claude-Mem worker is offline. Start Claude-Mem and retry.' }
          }
          const result = await WorkerClient.timeline({
            project: getProjectName(toolContext.sessionID),
            anchor: args.anchor,
            query: args.query,
            depthBefore: args.depth_before,
            depthAfter: args.depth_after,
          })
          return { content: result || 'No Claude-Mem timeline results found.' }
        },
      })

      tools.add({
        name: 'mem-get-observations',
        description:
          'Fetch full Claude-Mem observation details by ID. Use for IDs shown in the injected memory context or returned by mem-search/mem-timeline.',
        input: {
          type: 'object',
          properties: {
            ids: {
              type: 'array',
              items: { type: 'integer', minimum: 1 },
              description: 'Observation IDs to fetch',
            },
          },
          required: ['ids'],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input: any, toolContext) => {
          const args = input ?? {}
          if (!(await checkWorker())) {
            return { content: 'Claude-Mem worker is offline. Start Claude-Mem and retry.' }
          }
          const result = await WorkerClient.getObservations(
            args.ids || [],
            getProjectName(toolContext.sessionID)
          )
          return {
            content:
              result ||
              `No Claude-Mem observations found for IDs [${(args.ids || []).join(', ')}].`,
          }
        },
      })
    })

    /**
     * Event stream: session lifecycle.
     * Runs detached (never awaited in setup) with a retry if the stream drops.
     */
    let aborted = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined = undefined
    const subscribeAndHandleEvents = async (): Promise<void> => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (aborted) {
            return
          }
          try {
            await handleEvent(event)
          } catch {
            // silently fail — never let one event break the stream
          }
        }
      } catch {
        // stream error/disconnect — retry after a delay (unless unloaded)
      }
      if (!aborted) {
        retryTimer = setTimeout(() => {
          void subscribeAndHandleEvents()
        }, EVENT_RETRY_DELAY_MS)
      }
    }

    /**
     * Event handler: session lifecycle.
     * - session.created — record directory, invalidate context cache
     * - session.text.ended — capture complete assistant text as observation
     * - session.execution.succeeded / session.compaction.ended — summarize
     * - session.deleted — release local state; the worker self-completes
     */
    async function handleEvent(event: StreamEvent): Promise<void> {
      if (event.location && event.location.directory !== defaultDirectory) {
        return
      }
      switch (event.type) {
        case 'session.created': {
          const { data } = event
          if (!data?.sessionID) {
            return
          }
          const directory: unknown = data.location?.directory
          if ('parentID' in data && typeof data.parentID === 'string') {
            subagentSessions.add(data.sessionID)
          }
          if (typeof directory === 'string' && directory) {
            if (directory !== defaultDirectory) {
              return
            }
            sessionDirs.set(data.sessionID, directory)
          }
          // Invalidate context cache so the new session fetches fresh context
          // (includes summaries from previous sessions)
          memory.invalidate(data.sessionID)
          await checkWorker()
          return
        }

        case 'session.text.ended': {
          const { data } = event
          const sessionId: unknown = data?.sessionID
          const text: unknown = data?.text
          if (typeof sessionId !== 'string' || typeof text !== 'string' || !text) {
            return
          }
          if (!(await loadSessionLocation(sessionId))) {
            return
          }
          if (!memory.canCapture(sessionId)) {
            return
          }
          sessionAssistantTexts.set(sessionId, stripTaggedContent(text))
          if (!(await checkWorker())) {
            return
          }
          const sanitized = truncateUtf8Bytes(stripTaggedContent(text), MAX_OBSERVATION_BYTES)
          if (sanitized) {
            await sendObservation(
              sessionId,
              'assistant_message',
              { messageId: data.assistantMessageID },
              sanitized,
              `${data.assistantMessageID}:${data.ordinal}`
            )
          }
          return
        }

        case 'session.execution.succeeded':
        case 'session.compaction.ended': {
          const sessionId: unknown = event.data?.sessionID
          if (typeof sessionId !== 'string') {
            return
          }
          if (event.type === 'session.compaction.ended') {
            memory.invalidate(sessionId)
          }
          if (!(await checkWorker())) {
            return
          }
          if (!memory.canCapture(sessionId)) {
            return
          }
          try {
            await WorkerClient.summarize(
              sessionId,
              sessionUserTexts.get(sessionId) || '',
              sessionAssistantTexts.get(sessionId) || '',
              { observedModel: sessionModels.get(sessionId) }
            )
          } catch {
            // silently fail
          }
          return
        }

        case 'session.deleted': {
          const sessionId: unknown = event.data?.sessionID
          if (typeof sessionId !== 'string') {
            return
          }
          memory.delete(sessionId)
          files.delete(sessionId)
          admitted.delete(sessionId)
          compactions.delete(sessionId)
          subagentSessions.delete(sessionId)
          sessionDirs.delete(sessionId)
          sessionUserTexts.delete(sessionId)
          sessionAssistantTexts.delete(sessionId)
          sessionModels.delete(sessionId)
          return
        }

        default: {
          return
        }
      }
    }

    void subscribeAndHandleEvents()

    // Stop the event loop + retry timer when the plugin is unloaded/reloaded.
    return () => {
      aborted = true
      controller.abort()
      clearTimeout(retryTimer)
      memory.clear()
      files.clear()
      admitted.clear()
      compactions.clear()
      subagentSessions.clear()
      sessionDirs.clear()
      sessionUserTexts.clear()
      sessionAssistantTexts.clear()
      sessionModels.clear()
    }
  },
})
