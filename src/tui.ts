import { WorkerClient } from './worker-client'

const POLL_INTERVAL_MS = 5000
const LABEL_MAX = 28

export interface MemSidebarView {
  readonly healthy: boolean
  readonly project: string
  readonly observations: number | null
  readonly sessions: number | null
  readonly summaries: number | null
  readonly queueDepth: number | null
  readonly isProcessing: boolean
}

interface ViewNode {
  readonly kind: 'box' | 'text'
  readonly props: Record<string, unknown>
  readonly children?: readonly ViewNode[]
  readonly text?: string
}

interface Theme {
  readonly text: string
  readonly textMuted: string
  readonly info: string
  readonly success: string
  readonly warning: string
  readonly error: string
  readonly borderSubtle: string
}

function box(props: Record<string, unknown>, children: readonly ViewNode[]): ViewNode {
  return { kind: 'box', props, children }
}

function text(props: Record<string, unknown>, value: string): ViewNode {
  return { kind: 'text', props, text: value }
}

function truncate(value: string): string {
  return value.length <= LABEL_MAX ? value : `${value.slice(0, LABEL_MAX - 3)}...`
}

function formatCount(value: number | null): string {
  if (value === null) {
    return '-'
  }
  return value >= 10000 ? `${(value / 1000).toFixed(1)}k` : String(value)
}

export function buildMemNodes(view: MemSidebarView, theme: Theme): ViewNode[] {
  const rows: ViewNode[] = view.healthy
    ? [
        text({ fg: theme.success }, 'worker online'),
        text({ fg: theme.text }, `project ${truncate(view.project)}`),
        text(
          { fg: theme.text },
          `obs ${formatCount(view.observations)} · sum ${formatCount(view.summaries)}`
        ),
        text({ fg: theme.textMuted }, `sessions ${formatCount(view.sessions)}`),
        ...(view.isProcessing || (view.queueDepth ?? 0) > 0
          ? [text({ fg: theme.warning }, `processing · queue ${view.queueDepth ?? 0}`)]
          : []),
      ]
    : [text({ fg: theme.error }, 'worker offline')]

  return [
    box(
      {
        borderStyle: 'single',
        borderColor: theme.borderSubtle,
        flexDirection: 'column',
        padding: 1,
      },
      [text({ fg: theme.info }, 'Memory'), ...rows]
    ),
  ]
}

export function viewKey(view: MemSidebarView): string {
  return JSON.stringify(view)
}

function readCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export async function readMemView(project: string): Promise<MemSidebarView> {
  const stats = await WorkerClient.getStats()
  if (!stats) {
    return {
      healthy: false,
      project,
      observations: null,
      sessions: null,
      summaries: null,
      queueDepth: null,
      isProcessing: false,
    }
  }
  return {
    healthy: true,
    project,
    observations: readCount(stats.database?.observations),
    sessions: readCount(stats.database?.sessions),
    summaries: readCount(stats.database?.summaries),
    queueDepth: readCount(stats.processing?.queueDepth),
    isProcessing: stats.processing?.isProcessing === true,
  }
}

interface SolidRuntime {
  createElement(kind: string): unknown
  setProp(element: unknown, name: string, value: unknown): void
  insert(parent: unknown, child: unknown): void
}

function materializeNode(node: ViewNode, solid: SolidRuntime): unknown {
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

function materialize(nodes: readonly ViewNode[], solid: SolidRuntime): unknown {
  const root = solid.createElement('box')
  solid.setProp(root, 'flexDirection', 'column')
  for (const node of nodes) {
    solid.insert(root, materializeNode(node, solid))
  }
  return root
}

function projectNameFromDirectory(directory: string): string {
  return directory.split(/[\\/]/).findLast(Boolean) || 'unknown-project'
}

const tuiModule = {
  id: 'opencode-claude-mem:tui',
  tui: async (api: any) => {
    const solid: SolidRuntime | null = await import('@opentui/solid').catch(() => null)
    if (!solid) {
      return
    }

    const project = projectNameFromDirectory(String(api.state?.path?.directory ?? ''))
    let currentView = await readMemView(project)
    let currentKey = viewKey(currentView)
    let disposed = false
    let inFlight = false
    let timer: ReturnType<typeof setTimeout> | null = null

    api.slots.register({
      order: 910,
      slots: {
        sidebar_content: () => materialize(buildMemNodes(currentView, api.theme.current), solid),
      },
    })
    api.renderer.requestRender()

    const schedule = () => {
      timer = setTimeout(tick, POLL_INTERVAL_MS)
    }
    const tick = async () => {
      if (disposed || inFlight) {
        if (!disposed) {
          schedule()
        }
        return
      }
      inFlight = true
      try {
        const nextView = await readMemView(project)
        const nextKey = viewKey(nextView)
        if (nextKey !== currentKey) {
          currentView = nextView
          currentKey = nextKey
          api.renderer.requestRender()
        }
      } catch {
        // never throw into the TUI loop
      } finally {
        inFlight = false
        if (!disposed) {
          schedule()
        }
      }
    }
    schedule()

    api.lifecycle.onDispose(() => {
      disposed = true
      if (timer) {
        clearTimeout(timer)
      }
    })
  },
}

export default tuiModule
