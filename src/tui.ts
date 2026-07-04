import { WorkerClient } from './worker-client'

const POLL_INTERVAL_MS = 5000
const LABEL_MAX = 40
const RECENT_SUMMARIES = 3
const RECENT_OBSERVATIONS = 3

const OBSERVATION_TYPE_ICONS: Record<string, string> = {
  bugfix: '●',
  feature: '◆',
  refactor: '↻',
  change: '✓',
  discovery: '○',
  decision: '⚖',
  security_alert: '⚠',
  security_note: '⚷',
}

export interface MemSidebarView {
  readonly healthy: boolean
  readonly project: string
  readonly observations: number | null
  readonly sessions: number | null
  readonly summaries: number | null
  readonly queueDepth: number | null
  readonly isProcessing: boolean
  readonly recentSummaries: readonly { id: number; request: string }[]
  readonly recentObservations: readonly { id: number; type: string; title: string }[]
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

const HTML_ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&amp;': '&',
}

function decodeEntities(value: string): string {
  return value.replace(/&(?:lt|gt|quot|#39|amp);/g, (entity) => HTML_ENTITIES[entity] ?? entity)
}

function truncate(value: string): string {
  const decoded = decodeEntities(value)
  return decoded.length <= LABEL_MAX ? decoded : `${decoded.slice(0, LABEL_MAX - 1)}…`
}

function formatCount(value: number | null): string {
  if (value === null) {
    return '-'
  }
  return value >= 10000 ? `${(value / 1000).toFixed(1)}k` : String(value)
}

function summaryLine(view: MemSidebarView): { label: string; tone: 'ok' | 'warn' | 'err' } {
  if (!view.healthy) {
    return { label: '(offline)', tone: 'err' }
  }
  if (view.isProcessing || (view.queueDepth ?? 0) > 0) {
    return { label: `(queue ${view.queueDepth ?? 0})`, tone: 'warn' }
  }
  return { label: `(online, ${formatCount(view.observations)} obs)`, tone: 'ok' }
}

function toneColor(tone: 'ok' | 'warn' | 'err', theme: Theme): string {
  if (tone === 'err') {
    return theme.error
  }
  return tone === 'warn' ? theme.warning : theme.textMuted
}

function bulletRow(icon: string, iconColor: string, label: string, theme: Theme): ViewNode {
  return box({ flexDirection: 'row', gap: 1 }, [
    text({ fg: iconColor, flexShrink: 0 }, icon),
    text({ fg: theme.text, wrapMode: 'none' }, truncate(label)),
  ])
}

function expandedRows(view: MemSidebarView, theme: Theme): ViewNode[] {
  if (!view.healthy) {
    return [bulletRow('•', theme.error, 'worker offline', theme)]
  }

  const rows: ViewNode[] = [
    bulletRow(
      '•',
      theme.success,
      `obs ${formatCount(view.observations)} · sum ${formatCount(view.summaries)} · ses ${formatCount(view.sessions)}`,
      theme
    ),
  ]
  if (view.isProcessing || (view.queueDepth ?? 0) > 0) {
    rows.push(bulletRow('•', theme.warning, `processing · queue ${view.queueDepth ?? 0}`, theme))
  }

  if (view.recentSummaries.length > 0) {
    rows.push(text({ fg: theme.textMuted }, 'Recent sessions'))
    for (const summary of view.recentSummaries) {
      rows.push(bulletRow('•', theme.textMuted, summary.request, theme))
    }
  }

  if (view.recentObservations.length > 0) {
    rows.push(text({ fg: theme.textMuted }, 'Latest'))
    for (const observation of view.recentObservations) {
      const icon = OBSERVATION_TYPE_ICONS[observation.type] ?? '○'
      rows.push(bulletRow(icon, theme.info, observation.title, theme))
    }
  }

  return rows
}

export function buildMemNodes(
  view: MemSidebarView,
  theme: Theme,
  collapsed: boolean,
  onToggle: () => void
): ViewNode[] {
  const summary = summaryLine(view)
  const header = box({ flexDirection: 'row', gap: 1, onMouseDown: onToggle }, [
    text({ fg: theme.text }, collapsed ? '▶' : '▼'),
    text({ fg: theme.info }, 'Memory'),
    ...(collapsed ? [text({ fg: toneColor(summary.tone, theme) }, summary.label)] : []),
  ])

  return [
    box({ flexDirection: 'column', paddingTop: 1 }, [
      header,
      ...(collapsed
        ? []
        : [box({ flexDirection: 'column', paddingLeft: 2 }, expandedRows(view, theme))]),
    ]),
  ]
}

export function viewKey(view: MemSidebarView): string {
  return JSON.stringify(view)
}

function readCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export async function readMemView(project: string, collapsed: boolean): Promise<MemSidebarView> {
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
      recentSummaries: [],
      recentObservations: [],
    }
  }

  // Recent items are only rendered when expanded — skip the extra requests
  // while collapsed to keep the poll loop cheap.
  const [recentSummaries, recentObservations] = collapsed
    ? [[], []]
    : await Promise.all([
        WorkerClient.getRecentSummaries(project, RECENT_SUMMARIES),
        WorkerClient.getRecentObservations(project, RECENT_OBSERVATIONS),
      ])

  return {
    healthy: true,
    project,
    observations: readCount(stats.database?.observations),
    sessions: readCount(stats.database?.sessions),
    summaries: readCount(stats.database?.summaries),
    queueDepth: readCount(stats.processing?.queueDepth),
    isProcessing: stats.processing?.isProcessing === true,
    recentSummaries,
    recentObservations,
  }
}

interface SolidRuntime {
  createElement(kind: string): unknown
  setProp(element: unknown, name: string, value: unknown): void
  insert(parent: unknown, child: unknown): void
}

interface SolidCore {
  createSignal<T>(value: T): [() => T, (next: T) => void]
}

async function loadSolidCore(): Promise<SolidCore | null> {
  try {
    const mod: unknown = await import('solid-js')
    if (
      typeof mod === 'object' &&
      mod !== null &&
      typeof (mod as SolidCore).createSignal === 'function'
    ) {
      return mod as SolidCore
    }
    return null
  } catch {
    return null
  }
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

    // Reactive updates need OpenCode's own solid-js instance (same one that
    // drives the slot render effect). If it cannot be resolved, fall back to
    // plain closures — the panel still renders, only live toggle redraw
    // depends on requestRender re-invoking the slot.
    const solidCore = await loadSolidCore()
    const signal = <T>(value: T): [() => T, (next: T) => void] => {
      if (solidCore) {
        return solidCore.createSignal(value)
      }
      let current = value
      return [
        () => current,
        (next: T) => {
          current = next
        },
      ]
    }

    const project = projectNameFromDirectory(String(api.state?.path?.directory ?? ''))
    const initialView = await readMemView(project, true)
    const [collapsed, setCollapsed] = signal(true)
    const [view, setView] = signal(initialView)
    let currentKey = viewKey(initialView)
    let disposed = false
    let inFlight = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const refresh = async () => {
      const nextView = await readMemView(project, collapsed())
      const nextKey = viewKey(nextView)
      if (nextKey !== currentKey) {
        currentKey = nextKey
        setView(nextView)
        api.renderer.requestRender()
      }
    }

    const onToggle = () => {
      setCollapsed(!collapsed())
      api.renderer.requestRender()
      void refresh().catch(() => {})
    }

    api.slots.register({
      order: 910,
      slots: {
        sidebar_content: () =>
          materialize(buildMemNodes(view(), api.theme.current, collapsed(), onToggle), solid),
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
        await refresh()
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
