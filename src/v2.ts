import { define } from '@opencode-ai/plugin-v2/promise/plugin'
import { WorkerClient } from './worker-client'
import { ensureCliPluginEntry } from './tui-registration'
import {
  MAX_OBSERVATION_BYTES,
  extractTextFromParts,
  normalizeToolOutput,
  sanitizeObservationValue,
  shouldSkipObservationTool,
  stripTaggedContent,
  truncateUtf8Bytes,
} from './shared'

const EVENT_RETRY_DELAY_MS = 10_000

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

    // Worker health checked lazily — never during module load.
    let workerHealthy: boolean | null = null
    const initializedSessions = new Set<string>()
    // Per-session context cache — fetched once per session (mirrors V1 but
    // keyed by session because the V2 server hosts multiple sessions).
    const contextCache = new Map<string, string | null>()
    const sessionDirs = new Map<string, string>()
    const sessionUserTexts = new Map<string, string>()
    const sessionAssistantTexts = new Map<string, string>()
    let defaultDirectory = process.cwd()

    async function checkWorker(): Promise<boolean> {
      if (workerHealthy === null) {
        workerHealthy = await WorkerClient.ensureRunning()
      }
      return workerHealthy
    }

    function projectNameFromDirectory(directory: string): string {
      return directory.split(/[\\/]/).filter(Boolean).at(-1) || 'unknown-project'
    }

    function getProjectName(sessionId: string): string {
      return projectNameFromDirectory(sessionDirs.get(sessionId) || defaultDirectory)
    }

    /**
     * Idempotent session init with the worker (mirrors V1). Only marks the
     * session initialized when the worker actually persisted it.
     */
    async function ensureSessionInit(sessionId: string, prompt?: string): Promise<boolean> {
      if (initializedSessions.has(sessionId)) {
        return true
      }
      if (!(await checkWorker())) {
        return false
      }
      try {
        const result = await WorkerClient.sessionInit(
          sessionId,
          getProjectName(sessionId),
          prompt || 'SESSION_START'
        )
        if (!result) {
          return false
        }
        initializedSessions.add(sessionId)
        return true
      } catch {
        return false
      }
    }

    /** Context cache per session — invalidated on session.created. */
    async function getCachedContext(sessionId: string): Promise<string | null> {
      if (!contextCache.has(sessionId)) {
        contextCache.set(sessionId, await WorkerClient.getContext(getProjectName(sessionId)))
      }
      return contextCache.get(sessionId) ?? null
    }

    async function sendObservation(
      sessionId: string,
      toolName: string,
      toolInput: unknown,
      toolResponse: unknown
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
          sessionDirs.get(sessionId) || defaultDirectory
        )
      } catch {
        // silently fail
      }
    }

    /** Last user text in the message list (V2 `Message.content` parts). */
    function extractLastUserText(messages: unknown[]): string {
      if (!Array.isArray(messages)) {
        return ''
      }
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i] as any
        if (!message || message.role !== 'user') {
          continue
        }
        const text = extractTextFromParts(message.content)
        if (text) {
          return text
        }
      }
      return ''
    }

    /** Normalize a V2 Tool.Result ({ output?, content? }) to text. */
    function normalizeToolResult(result: unknown): string {
      if (typeof result === 'string') {
        return result
      }
      if (!result || typeof result !== 'object') {
        return normalizeToolOutput(result)
      }
      const record = result as Record<string, unknown>
      const content = record['content']
      if (typeof content === 'string') {
        return content
      }
      if (Array.isArray(content)) {
        const text = content
          .map((part: any) =>
            part && part.type === 'text' && typeof part.text === 'string' ? part.text : ''
          )
          .filter(Boolean)
          .join('\n')
          .trim()
        if (text) {
          return text
        }
      }
      if (record['output'] !== undefined) {
        return normalizeToolOutput(record['output'])
      }
      return normalizeToolOutput(result)
    }

    /**
     * Hook: Session Context
     * Fires immediately before model dispatch. Initializes the session with
     * the real user prompt (from the message list) and injects the cached
     * memory context into the system parts.
     */
    await ctx.session.hook('context', async (event) => {
      const sessionId = event.sessionID
      if (!sessionId) {
        return
      }
      sessionUserTexts.set(sessionId, extractLastUserText(event.messages))
      await ensureSessionInit(sessionId, sessionUserTexts.get(sessionId))
      if (!(await checkWorker())) {
        return
      }
      try {
        const context = await getCachedContext(sessionId)
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
      await sendObservation(sessionId, event.tool, sanitizedInput, sanitizedOutput)
    })

    /**
     * Custom memory tools. `codemode: false` exposes them directly to the
     * provider (default `codemode: true` would only expose them via `execute`).
     */
    await ctx.tool.transform((tools) => {
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
    const subscribeAndHandleEvents = async (): Promise<void> => {
      try {
        for await (const event of ctx.event.subscribe()) {
          try {
            await handleEvent(event)
          } catch {
            // silently fail — never let one event break the stream
          }
        }
      } catch {
        // stream error/disconnect — retry after a delay (unless unloaded)
        if (aborted) {
          return
        }
        setTimeout(() => {
          void subscribeAndHandleEvents()
        }, EVENT_RETRY_DELAY_MS)
      }
    }

    /**
     * Event handler: session lifecycle.
     * - session.created — record directory, invalidate context cache
     * - session.text.ended — capture complete assistant text as observation
     * - session.execution.succeeded / session.compaction.ended — summarize
     * - session.deleted — complete the session on the worker
     */
    async function handleEvent(event: any): Promise<void> {
      switch (event.type) {
        case 'session.created': {
          const data = event.data
          if (!data?.sessionID) {
            return
          }
          const directory: unknown = data.location?.directory
          if (typeof directory === 'string' && directory) {
            sessionDirs.set(data.sessionID, directory)
            defaultDirectory = directory
          }
          // Invalidate context cache so the new session fetches fresh context
          // (includes summaries from previous sessions)
          contextCache.delete(data.sessionID)
          await checkWorker()
          return
        }

        case 'session.text.ended': {
          const data = event.data
          const sessionId: unknown = data?.sessionID
          const text: unknown = data?.text
          if (typeof sessionId !== 'string' || typeof text !== 'string' || !text) {
            return
          }
          sessionAssistantTexts.set(sessionId, text)
          if (!(await checkWorker())) {
            return
          }
          const sanitized = truncateUtf8Bytes(stripTaggedContent(text), MAX_OBSERVATION_BYTES)
          if (sanitized) {
            await sendObservation(
              sessionId,
              'assistant_message',
              { messageId: data.assistantMessageID },
              sanitized
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
          if (!(await checkWorker())) {
            return
          }
          try {
            await WorkerClient.summarize(
              sessionId,
              sessionUserTexts.get(sessionId) || '',
              sessionAssistantTexts.get(sessionId) || ''
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
          initializedSessions.delete(sessionId)
          contextCache.delete(sessionId)
          sessionDirs.delete(sessionId)
          sessionUserTexts.delete(sessionId)
          sessionAssistantTexts.delete(sessionId)
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
    }

    void subscribeAndHandleEvents()

    // Stop the event loop + retry timer when the plugin is unloaded/reloaded.
    return () => {
      aborted = true
    }
  },
})
