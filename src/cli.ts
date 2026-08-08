import { define } from '@opencode-ai/plugin-v2/tui/plugin'
import type { ResolvedTheme } from '@opencode-ai/theme/tui'
import type { JSX } from '@opentui/solid'
import {
  POLL_INTERVAL_MS,
  type MemSidebarView,
  type Theme,
  buildMemNodes,
  readMemView,
  viewKey,
  type ViewNode,
} from './sidebar-model'

const REFRESH_EVENTS = ['session.created', 'session.execution.succeeded'] as const

interface SidebarState {
  collapsed: boolean
  view: MemSidebarView
}

function emptyView(project: string): MemSidebarView {
  return {
    healthy: false,
    project,
    observations: null,
    sessions: null,
    summaries: null,
    queueDepth: null,
    isProcessing: false,
    recentSummaries: [],
    recentObservations: [],
  }
}

/**
 * OpenCode V2 TUI plugin for Claude-Mem (the Memory sidebar).
 *
 * Loaded from `~/.config/opencode/cli.json` via the package's `./cli`
 * export:
 *
 * ```json
 * { "plugins": ["@ephemushroom/opencode-claude-mem/cli"] }
 * ```
 *
 * V2 TUI plugins are `Plugin.define({ id, setup })` modules rendered inside
 * the TUI process with @opentui/solid elements — the same element model as the
 * V1 sidebar, but registered through `ctx.ui.slot("sidebar.content")` with
 * reactive state from `ctx.storage.memory` (survives hot reloads).
 */
export default define({
  id: 'claude-mem.tui',
  setup: async (ctx) => {
    const solid = await import('@opentui/solid').catch(() => null)
    if (!solid) {
      return
    }

    const project =
      String(ctx.location?.directory ?? process.cwd())
        .split(/[\\/]/)
        .filter(Boolean)
        .findLast(Boolean) ?? 'unknown-project'
    const theme = themeFromResolved(ctx.theme)

    const [state, setState] = ctx.storage.memory<SidebarState>('claude-mem.sidebar', {
      initial: { collapsed: true, view: emptyView(project) },
    })

    let disposed = false
    let inFlight = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const refresh = async (): Promise<void> => {
      if (inFlight) {
        return
      }
      inFlight = true
      try {
        const next = await readMemView(project, state.collapsed)
        setState((draft) => {
          if (viewKey(draft.view) !== viewKey(next)) {
            draft.view = next
          }
        })
      } catch {
        // never throw into the TUI loop
      } finally {
        inFlight = false
      }
    }

    const onToggle = () => {
      setState((draft) => {
        draft.collapsed = !draft.collapsed
      })
      void refresh().catch(() => {})
    }

    const disposeSlot = ctx.ui.slot('sidebar.content', () =>
      materialize(buildMemNodes(state.view, theme, state.collapsed, onToggle), solid)
    )

    // Immediate refresh on session activity; the 5s poll covers the rest.
    const disposeEvents = REFRESH_EVENTS.map((type) =>
      ctx.data.on(type, () => {
        void refresh().catch(() => {})
      })
    )

    const schedule = () => {
      timer = setTimeout(tick, POLL_INTERVAL_MS)
    }
    const tick = async () => {
      if (disposed) {
        return
      }
      await refresh()
      if (!disposed) {
        schedule()
      }
    }
    void refresh()
      .catch(() => {})
      .finally(() => {
        if (disposed) {
          return
        }
        // One-time status toast, mirroring the V1 server plugin's init toast.
        if (!state.view.healthy) {
          ctx.ui.toast.show({
            title: 'Claude-Mem',
            message: 'Worker offline — start Claude Code or run bunx claude-mem start',
            variant: 'warning',
            duration: 5000,
          })
        }
        schedule()
      })

    return () => {
      disposed = true
      if (timer) {
        clearTimeout(timer)
      }
      disposeSlot()
      for (const dispose of disposeEvents) {
        dispose()
      }
    }
  },
})

function themeFromResolved(resolved: ResolvedTheme): Theme {
  const { text } = resolved
  return {
    text: text.default,
    textMuted: text.subdued,
    info: text.action.primary.default,
    success: text.feedback.success.default,
    warning: text.feedback.warning.default,
    error: text.feedback.error.default,
    borderSubtle: resolved.border.default,
  }
}

interface SolidRuntime {
  createElement(kind: string): unknown
  setProp(element: unknown, name: string, value: unknown): void
  insert(parent: unknown, child: unknown): void
}

function materializeNode(node: ViewNode, solid: SolidRuntime): JSX.Element {
  const element = solid.createElement(node.kind)
  for (const [name, value] of Object.entries(node.props)) {
    solid.setProp(element, name, value)
  }
  if (node.kind === 'text') {
    solid.insert(element, node.text ?? '')
  }
  for (const child of node.children ?? []) {
    solid.insert(element, materializeNode(child, solid))
  }
  return element as JSX.Element
}

function materialize(nodes: readonly ViewNode[], solid: SolidRuntime): JSX.Element {
  const root = solid.createElement('box')
  solid.setProp(root, 'flexDirection', 'column')
  for (const node of nodes) {
    solid.insert(root, materializeNode(node, solid))
  }
  return root as JSX.Element
}
