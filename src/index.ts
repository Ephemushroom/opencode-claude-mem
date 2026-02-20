import { type Plugin, tool } from '@opencode-ai/plugin'
import { WorkerClient } from './worker-client'

/**
 * OpenCode Plugin for Claude-Mem
 *
 * Hooks used:
 * - `event` �?session lifecycle (session.created, session.idle)
 * - `tool.execute.after` �?capture tool observations
 * - `experimental.chat.system.transform` �?inject memory context into system prompt
 * - `chat.message` �?fallback session init when event hook doesn't fire
 * - `tool` �?mem-search custom tool
 *
 * Uses TUI toast notifications for status feedback.
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
      // TUI not available or API changed �?ignore
    }
  }

  /**
   * Send a status message into the chat flow as an ignored user message.
   * Visible to the user in TUI but not sent to the LLM.
   * Falls back to toast if session prompt injection fails.
   */
  async function sendStatusMessage(sessionId: string, text: string): Promise<void> {
    try {
      await client.session.prompt({
        path: { id: sessionId },
        body: {
          noReply: true,
          parts: [{ type: 'text', text, ignored: true }],
        },
      })
    } catch {
      await toast(text.slice(0, 200), 'info')
    }
  }


  // Worker health checked lazily �?avoid calling client.tui during plugin init
  // (TUI may not be ready yet, causing OpenCode to crash on startup)
  let workerHealthy: boolean | null = null
  let initToastShown = false

  /** Lazy worker health check + deferred init toast */
  async function checkWorkerAndToast(): Promise<boolean> {
    if (workerHealthy === null) {
      workerHealthy = await WorkerClient.isHealthy()
    }
    if (!initToastShown) {
      initToastShown = true
      if (workerHealthy) {
        await toast(`Memory active · ${projectName}`, 'success')
      } else {
        await toast('Worker offline �?start Claude Code first', 'warning', 5000)
      }
    }
    return workerHealthy
  }

  let currentSessionId: string | null = null
  const initializedSessions = new Set<string>()

  /**
   * Helper: ensure a session is initialized with the worker.
   * Idempotent �?safe to call multiple times for the same session.
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
   * Helper: extract text content from message parts.
   * Parts can be TextPart, ToolCallPart, etc. We only want text.
   */
  function extractTextFromParts(parts: any[]): string {
    if (!parts || !Array.isArray(parts)) {
      return ''
    }
    return parts
      .filter((p: any) => p.type === 'text' && typeof p.text === 'string')
      .map((p: any) => p.text)
      .join('\n')
      .trim()
  }

  return {
    /**
     * Hook: Event
     * Handles session.created and session.idle events
     */
    event: async ({ event }: { event: any }) => {
      if (event.type === 'session.created') {
        const sessionId = event.properties?.info?.id
        if (!sessionId) {
          return
        }
        // Do NOT call ensureSessionInit �?that would use "SESSION_START" as prompt.
        // Let chat.message handle init with the real user prompt.
        currentSessionId = sessionId
        const isHealthy = await checkWorkerAndToast()
        if (isHealthy) {
          // Fetch context and display inline (like Claude Code SessionStart)
          try {
            const context = await WorkerClient.getContext(projectName)
            if (context) {
              await sendStatusMessage(sessionId, context)
            } else {
              await toast(`Memory active · ${projectName}`, 'success', 2000)
            }
          } catch {
            await toast(`Memory active · ${projectName}`, 'success', 2000)
          }
        }
      }

      if (event.type === 'session.idle') {
        const sessionId = event.properties?.sessionID || currentSessionId
        if (!sessionId) {
          return
        }

        try {
          // P1: Fetch actual messages from the session for summarization
          let lastUserMessage = ''
          let lastAssistantMessage = ''

          try {
            const result = await client.session.messages({
              path: { id: sessionId },
            })

            if (result.data && Array.isArray(result.data)) {
              const messages = result.data

              // Find last user message
              for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].info.role === 'user') {
                  lastUserMessage = extractTextFromParts(messages[i].parts)
                  break
                }
              }

              // Find last assistant message
              for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].info.role === 'assistant') {
                  lastAssistantMessage = extractTextFromParts(messages[i].parts)
                  break
                }
              }
            }
          } catch {
            // If fetching messages fails, proceed with empty strings
          }

          await WorkerClient.summarize(sessionId, lastUserMessage, lastAssistantMessage)
          await WorkerClient.completeSession(sessionId)
          await toast('Session summarized', 'success', 2000)
        } catch {
          // silently fail
        }
      }
    },

    /**
     * Hook: Chat Message
     * Fallback session initialization �?if event hook doesn't fire session.created,
     * we init the session on the first chat message instead.
     * P2: Extracts the actual user prompt from output.parts and passes it to sessionInit.
     */
    'chat.message': async (input, output) => {
      const sessionId = input.sessionID
      if (sessionId) {
        // P2: Extract user prompt text from the message parts
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
        const context = await WorkerClient.getContext(projectName)
        if (context) {
          output.system.push(`[Claude-Mem] Memory Active. Previous Context:\n${context}`)
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

      // Ensure session is initialized before sending observations
      await ensureSessionInit(sessionId)

      try {
        await WorkerClient.sendObservation(
          sessionId,
          input.tool,
          input.args || {},
          output.output,
          projectRoot
        )
      } catch {
        // Silently fail - don't block tool execution
      }
    },

    /**
     * Custom Tool: Mem-Search
     */
    tool: {
      'mem-search': tool({
        description:
          'Search project history and memory. Use this to find information about past decisions, code changes, or bug fixes.',
        args: {
          query: tool.schema.string(),
        },
        execute: async (args: { query: string }) =>
          await WorkerClient.search(args.query, projectName),
      }),
    },
  }
}
