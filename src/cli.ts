import {
  type MemDetail,
  type MemSidebarView,
  POLL_INTERVAL_MS,
  type RecentItemHandler,
  type Theme,
  type ViewNode,
  buildMemNodes,
  readDetail,
  readMemView,
  viewKey,
} from './sidebar-model'
import { Plugin } from '@opencode/plugin/tui'
import type { Context } from '@opencode/plugin/tui/context'
import type { ResolvedTheme } from '@opencode/theme/tui'
import type { SyntaxStyle } from '@opentui/core'
import type { JSX, createElement, insert, onResize, setProp } from '@opentui/solid'

const REFRESH_EVENTS = ['session.created', 'session.execution.succeeded'] as const

interface SidebarState {
  collapsed: boolean
  view: MemSidebarView
}

function emptyView(project: string): MemSidebarView {
  return {
    healthy: false,
    capture: null,
    project,
    scope: 'all',
    totalObservations: null,
    observations: null,
    sessions: null,
    summaries: null,
    queueDepth: null,
    isProcessing: false,
    asOf: 0,
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
 * V1 sidebar, but registered through a `sidebar.content` slot claim with
 * reactive state from `ctx.storage.memory` (survives hot reloads).
 */
export default Plugin.define({
  id: 'claude-mem.tui',
  setup: async (ctx) => {
    const solid = await import('@opentui/solid').catch(() => null)
    if (!solid) {
      return
    }

    const directory = String(ctx.location?.directory ?? process.cwd())
    const project = directory.split(/[\\/]/).filter(Boolean).findLast(Boolean) ?? 'unknown-project'
    const [state, setState] = ctx.storage.memory<SidebarState>('claude-mem.sidebar', {
      initial: { collapsed: true, view: emptyView(project) },
    })

    let disposed = false
    let inFlight = false
    let refreshPending = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const refresh = async (): Promise<void> => {
      if (disposed) {
        return
      }
      if (inFlight) {
        refreshPending = true
        return
      }
      inFlight = true
      try {
        do {
          refreshPending = false
          const { collapsed } = state
          // Serialize reads: a pending toggle must use the latest collapse state.
          // eslint-disable-next-line no-await-in-loop
          const next = await readMemView(project, collapsed, directory)
          if (disposed) {
            return
          }
          if (collapsed === state.collapsed) {
            setState((draft) => {
              if (viewKey(draft.view) !== viewKey(next)) {
                draft.view = next
              }
            })
          }
        } while (refreshPending)
      } catch {
        // never throw into the TUI loop
      } finally {
        inFlight = false
      }
    }

    const onToggle = () => {
      if (disposed) {
        return
      }
      setState((draft) => {
        draft.collapsed = !draft.collapsed
      })
      void refresh().catch(() => {})
    }

    let opening = false
    const onSelect: RecentItemHandler = (kind, id) => {
      if (disposed || opening) {
        return
      }
      opening = true
      void Promise.all([readDetail(kind, id), import('@opentui/core').catch(() => null)])
        .then(([detail, core]) => {
          if (disposed) {
            return
          }
          if (!detail) {
            ctx.ui.toast.show({
              title: 'Claude-Mem',
              message: `Could not load ${kind} #${id} from the Worker`,
              variant: 'warning',
              duration: 3000,
            })
            return
          }
          return new Promise<void>((closed) => {
            let activeStyle: SyntaxStyle | undefined = undefined
            const retireStyle = (style: SyntaxStyle | undefined) => {
              if (!style) {
                return
              }
              // Destroy after the renderer finishes painting the closing frame.
              void ctx.renderer.idle().then(
                () => style.destroy(),
                () => style.destroy()
              )
            }
            const onClose = () => {
              const target = activeStyle
              activeStyle = undefined
              retireStyle(target)
              closed()
            }
            ctx.ui.dialog.show(
              () =>
                renderDetail(ctx, solid, core?.SyntaxStyle ?? null, detail, (nextStyle) => {
                  retireStyle(activeStyle)
                  activeStyle = nextStyle
                }),
              onClose
            )
          })
        })
        .catch(() => {})
        .finally(() => {
          opening = false
        })
    }

    const disposeSlot = ctx.ui.slot({
      append: 'sidebar.content',
      render: () =>
        materialize(
          () =>
            buildMemNodes(
              state.view,
              themeFromResolved(ctx.theme),
              state.collapsed,
              onToggle,
              onSelect
            ),
          solid
        ),
    })

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
        schedule()
        // One-time status toast, mirroring the V1 server plugin's init toast.
        if (!state.view.healthy) {
          ctx.ui.toast.show({
            title: 'Claude-Mem',
            message: 'Worker offline — start Claude Code or run bunx claude-mem start',
            variant: 'warning',
            duration: 5000,
          })
        }
      })
      .catch(() => {})

    return () => {
      if (disposed) {
        return
      }
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
    text: text.base,
    textMuted: text.muted,
    info: text.action.primary.base,
    success: text.feedback.success.base,
    warning: text.feedback.warning.base,
    error: text.feedback.error.base,
    borderSubtle: resolved.border.base,
  }
}

interface SolidRuntime {
  createElement: typeof createElement
  setProp: typeof setProp
  insert: typeof insert
}

function buildMarkdownStyle(
  theme: ResolvedTheme,
  syntaxStyleClass: typeof SyntaxStyle,
  owner: unknown
): SyntaxStyle {
  const { markdown, syntax } = theme
  const scope = (
    names: string[],
    foreground: ResolvedTheme['text']['base'],
    extra: { bold?: boolean; italic?: boolean; underline?: boolean } = {}
  ) => ({
    scope: names,
    style: { foreground, ...extra },
  })
  return syntaxStyleClass.fromTheme(
    [
      scope(['default', 'spell', 'nospell'], theme.text.base),
      scope(['conceal', 'markup.strikethrough', 'markup.list.unchecked'], theme.text.muted),
      scope(
        [
          'markup.heading',
          'markup.heading.2',
          'markup.heading.3',
          'markup.heading.4',
          'markup.heading.5',
          'markup.heading.6',
        ],
        markdown.heading,
        { bold: true }
      ),
      scope(['markup.heading.1'], markdown.heading, { bold: true, underline: true }),
      scope(['markup.bold', 'markup.strong'], markdown.strong, { bold: true }),
      scope(['markup.italic'], markdown.emphasis, { italic: true }),
      scope(['markup.list'], markdown.listItem),
      scope(['markup.list.checked'], theme.text.feedback.success.base),
      scope(['markup.quote'], markdown.blockQuote, { italic: true }),
      scope(['markup.raw', 'markup.raw.block', 'markup.raw.inline'], markdown.code),
      scope(['markup.link', 'markup.link.url', 'string.special.url'], markdown.link, {
        underline: true,
      }),
      scope(['markup.link.label', 'label'], markdown.linkText),
      scope(['comment'], syntax.comment, { italic: true }),
      scope(['string'], syntax.string),
      scope(['number', 'boolean', 'constant'], syntax.number),
      scope(['keyword'], syntax.keyword, { italic: true }),
      scope(['function', 'function.call', 'function.method'], syntax.function),
      scope(['variable', 'property', 'parameter'], syntax.variable),
      scope(['type', 'module', 'class'], syntax.type),
      scope(['operator', 'punctuation.special'], syntax.operator),
      scope(['punctuation', 'punctuation.bracket', 'punctuation.delimiter'], syntax.punctuation),
    ],
    owner as Parameters<typeof SyntaxStyle.fromTheme>[1]
  )
}

function renderDetail(
  ctx: Context,
  solid: SolidRuntime & { onResize: typeof onResize },
  syntaxStyleClass: typeof SyntaxStyle | null,
  detail: MemDetail,
  onStyle: (style: SyntaxStyle) => void
): JSX.Element {
  // Set presentation on the active host modal, not on the sidebar's layout.
  ctx.ui.dialog.set({ size: 'xlarge', centered: true })
  const panel = solid.createElement('box')
  solid.setProp(panel, 'flexDirection', 'column')
  solid.setProp(panel, 'padding', 1)
  solid.setProp(panel, 'gap', 1)
  const header = solid.createElement('box')
  solid.setProp(header, 'flexDirection', 'row')
  solid.setProp(header, 'gap', 2)
  const title = solid.createElement('text')
  solid.setProp(title, 'fg', ctx.theme.text.base)
  solid.setProp(title, 'attributes', 1)
  solid.setProp(title, 'flexGrow', 1)
  solid.setProp(title, 'wrapMode', 'none')
  solid.setProp(title, 'truncate', true)
  solid.insert(title, detail.title)
  solid.insert(header, title)
  const close = solid.createElement('text')
  solid.setProp(close, 'fg', ctx.theme.text.muted)
  solid.setProp(close, 'flexShrink', 0)
  solid.setProp(close, 'onMouseUp', (event: { button: number }) => {
    if (event.button === 0) {
      ctx.ui.dialog.clear()
    }
  })
  solid.insert(close, 'esc close')
  solid.insert(header, close)
  solid.insert(panel, header)

  const body = solid.createElement('scrollbox')
  solid.setProp(body, 'scrollX', false)
  const sizeBody = (height: number) =>
    solid.setProp(body, 'maxHeight', Math.max(1, Math.floor(height * 0.75) - 4))
  sizeBody(ctx.renderer.height)
  solid.onResize((_width, height) => sizeBody(height))
  const owner = (ctx.renderer as { nativeScene?: unknown }).nativeScene
  const markdownTheme = ctx.theme as Partial<ResolvedTheme>
  if (syntaxStyleClass && owner && markdownTheme.markdown && markdownTheme.syntax) {
    const style = buildMarkdownStyle(ctx.theme, syntaxStyleClass, owner)
    onStyle(style)
    const markdown = solid.createElement('markdown')
    solid.setProp(markdown, 'content', detail.message)
    solid.setProp(markdown, 'syntaxStyle', style)
    solid.setProp(markdown, 'fg', ctx.theme.text.base)
    solid.setProp(markdown, 'conceal', true)
    solid.setProp(markdown, 'tableOptions', { style: 'grid', cellPaddingX: 1 })
    solid.insert(body, markdown)
  } else {
    const message = solid.createElement('text')
    solid.setProp(message, 'fg', ctx.theme.text.base)
    solid.setProp(message, 'wrapMode', 'word')
    solid.insert(message, detail.message)
    solid.insert(body, message)
  }
  solid.insert(panel, body)
  return panel
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
  return element
}

function materialize(nodes: () => readonly ViewNode[], solid: SolidRuntime): JSX.Element {
  const root = solid.createElement('box')
  solid.setProp(root, 'flexDirection', 'column')
  // Slot components render once; the accessor owns reactive updates and host cleanup.
  solid.insert(root, () => nodes().map((node) => materializeNode(node, solid)))
  return root
}
