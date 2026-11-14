import { type CaptureStatus, readCaptureStatus } from './capture-status'
import { WorkerClient } from './worker-client'

export const POLL_INTERVAL_MS = 5000
const RECENT_SUMMARIES = 3
const RECENT_OBSERVATIONS = 3

export const OBSERVATION_TYPE_ICONS: Record<string, string> = {
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
  /** What this package's server part reported; null when it is not loaded. */
  readonly capture: CaptureStatus | null
  readonly project: string
  /** `project` when counts come from the Worker database; `all` for the global fallback. */
  readonly scope: 'project' | 'all'
  readonly totalObservations: number | null
  readonly observations: number | null
  readonly sessions: number | null
  readonly summaries: number | null
  readonly queueDepth: number | null
  readonly isProcessing: boolean
  /** Start of the minute the ages are measured from; ticks once a minute. */
  readonly asOf: number
  readonly recentSummaries: readonly { id: number; request: string; at: number | null }[]
  readonly recentObservations: readonly {
    id: number
    type: string
    title: string
    at: number | null
  }[]
}

export type RecentItemKind = 'summary' | 'observation'

/** Receives a click on a recent row; ids address the Worker's detail endpoints. */
export type RecentItemHandler = (kind: RecentItemKind, id: number) => void

export interface ViewNode {
  readonly kind: 'box' | 'text'
  readonly props: Record<string, unknown>
  readonly children?: readonly ViewNode[]
  readonly text?: string
}

export interface Theme {
  readonly text: unknown
  readonly textMuted: unknown
  readonly info: unknown
  readonly success: unknown
  readonly warning: unknown
  readonly error: unknown
  readonly borderSubtle: unknown
}

export function box(props: Record<string, unknown>, children: readonly ViewNode[]): ViewNode {
  return { kind: 'box', props, children }
}

export function text(props: Record<string, unknown>, value: string): ViewNode {
  return { kind: 'text', props, text: value }
}

const HTML_ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&amp;': '&',
}

export function decodeEntities(value: string): string {
  return value.replace(/&(?:lt|gt|quot|#39|amp);/g, (entity) => HTML_ENTITIES[entity] ?? entity)
}

/**
 * Drops the current project's name from a title: every row in this sidebar already belongs
 * to that project, so repeating it costs the space the rest of the title needs. Whole-token
 * matches only, so a name inside a longer word survives. Returns the input when nothing else
 * is left.
 */
export function stripProjectName(value: string, project: string): string {
  const decoded = decodeEntities(value)
  const name = project.trim()
  if (!name) {
    return decoded
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
  const stripped = decoded
    .replace(new RegExp(`(?<![\\w.@-])(?:[\\w.@-]+/)?${escaped}(?![\\w.-])`, 'giu'), ' ')
    .replaceAll(/\s{2,}/g, ' ')
    .replaceAll(/\s+([，。、；：,.:;])/g, '$1')
    .replace(/^[\s:：,，、;；·|–—-]+/u, '')
    .trim()
  return stripped || decoded
}

/** Short age such as `just now`, `12m ago`, `3h ago`, `2d ago`, then a calendar date. */
export function formatAge(at: number | null, now: number): string {
  if (at === null || !Number.isFinite(at)) {
    return ''
  }
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 1) {
    return 'just now'
  }
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h ago`
  }
  const days = Math.floor(hours / 24)
  if (days < 7) {
    return `${days}d ago`
  }
  const date = new Date(at)
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function formatCount(value: number | null): string {
  if (value === null) {
    return '-'
  }
  return value >= 10000 ? `${(value / 1000).toFixed(1)}k` : String(value)
}

export function summaryLine(view: MemSidebarView): { label: string; tone: 'ok' | 'warn' | 'err' } {
  if (!view.healthy) {
    return { label: '(offline)', tone: 'err' }
  }
  if (view.capture?.state === 'problem') {
    return { label: '(capture off)', tone: 'err' }
  }
  if (view.isProcessing || (view.queueDepth ?? 0) > 0) {
    return { label: `(queue ${view.queueDepth ?? 0})`, tone: 'warn' }
  }
  return { label: `(online, ${formatCount(view.observations)} obs)`, tone: 'ok' }
}

export function toneColor(tone: 'ok' | 'warn' | 'err', theme: Theme): unknown {
  if (tone === 'err') {
    return theme.error
  }
  return tone === 'warn' ? theme.warning : theme.textMuted
}

// The renderer truncates by display width, so wide CJK text gets an ellipsis too.
function label(color: unknown, value: string): ViewNode {
  return text({ fg: color, wrapMode: 'none', truncate: true }, value)
}

export function bulletRow(
  icon: string,
  iconColor: unknown,
  value: string,
  theme: Theme,
  labelColor: unknown = theme.text
): ViewNode {
  return box({ flexDirection: 'row', gap: 1 }, [
    text({ fg: iconColor, flexShrink: 0 }, icon),
    label(labelColor, decodeEntities(value)),
  ])
}

/** A recent item: its title, then a muted age line, clickable when a handler is given. */
function recentRow(
  icon: string,
  iconColor: unknown,
  title: string,
  age: string,
  theme: Theme,
  onSelect: (() => void) | undefined
): ViewNode {
  return box({ flexDirection: 'column', ...(onSelect ? { onMouseDown: onSelect } : {}) }, [
    bulletRow(icon, iconColor, title, theme),
    ...(age ? [box({ paddingLeft: 2 }, [label(theme.textMuted, age)])] : []),
  ])
}

export function expandedRows(
  view: MemSidebarView,
  theme: Theme,
  onSelect?: RecentItemHandler
): ViewNode[] {
  // The server part's message names the fix (a command to run), so it wraps instead of
  // being cut to one line.
  const notice = view.capture?.message
    ? [
        box({ flexDirection: 'row', gap: 1 }, [
          text({ fg: theme.warning, flexShrink: 0 }, '!'),
          text(
            {
              fg: view.capture.state === 'problem' ? theme.error : theme.warning,
              wrapMode: 'word',
            },
            view.capture.message
          ),
        ]),
      ]
    : []
  if (!view.healthy) {
    return [bulletRow('•', theme.error, 'worker offline', theme), ...notice]
  }

  const counts = `obs ${formatCount(view.observations)} · sum ${formatCount(view.summaries)} · ses ${formatCount(view.sessions)}`
  const rows: ViewNode[] = [
    ...notice,
    bulletRow('•', theme.success, view.scope === 'all' ? `all · ${counts}` : counts, theme),
  ]
  if (view.scope === 'project') {
    rows.push(
      bulletRow(
        '•',
        theme.textMuted,
        `all ${formatCount(view.totalObservations)} obs`,
        theme,
        theme.textMuted
      )
    )
  }
  if (view.isProcessing || (view.queueDepth ?? 0) > 0) {
    rows.push(bulletRow('•', theme.warning, `processing · queue ${view.queueDepth ?? 0}`, theme))
  }

  if (view.recentSummaries.length > 0) {
    rows.push(text({ fg: theme.textMuted }, 'Recent sessions'))
    for (const summary of view.recentSummaries) {
      rows.push(
        recentRow(
          '•',
          theme.textMuted,
          stripProjectName(summary.request, view.project),
          formatAge(summary.at, view.asOf),
          theme,
          onSelect && (() => onSelect('summary', summary.id))
        )
      )
    }
  }

  if (view.recentObservations.length > 0) {
    rows.push(text({ fg: theme.textMuted }, 'Latest'))
    for (const observation of view.recentObservations) {
      const icon = OBSERVATION_TYPE_ICONS[observation.type] ?? '○'
      rows.push(
        recentRow(
          icon,
          theme.info,
          stripProjectName(observation.title, view.project),
          [formatAge(observation.at, view.asOf), `#${observation.id}`].filter(Boolean).join(' · '),
          theme,
          onSelect && (() => onSelect('observation', observation.id))
        )
      )
    }
  }

  if (onSelect && view.recentSummaries.length + view.recentObservations.length > 0) {
    rows.push(label(theme.textMuted, 'Click an item for details'))
  }

  return rows
}

export function buildMemNodes(
  view: MemSidebarView,
  theme: Theme,
  collapsed: boolean,
  onToggle: () => void,
  onSelect?: RecentItemHandler
): ViewNode[] {
  const summary = summaryLine(view)
  const header = box({ flexDirection: 'row', gap: 1, onMouseDown: onToggle }, [
    text({ fg: theme.text, flexShrink: 0 }, collapsed ? '▶' : '▼'),
    // TextAttributes.BOLD; keep this shared model independent of the native TUI runtime.
    text({ fg: theme.info, attributes: 1, flexShrink: 0 }, 'Memory'),
    collapsed
      ? text({ fg: toneColor(summary.tone, theme) }, summary.label)
      : label(theme.textMuted, view.project),
  ])

  return [
    box({ flexDirection: 'column', paddingTop: 1 }, [
      header,
      ...(collapsed
        ? []
        : [box({ flexDirection: 'column', paddingLeft: 2 }, expandedRows(view, theme, onSelect))]),
    ]),
  ]
}

export function viewKey(view: MemSidebarView): string {
  return JSON.stringify(view)
}

function readCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export async function readMemView(
  project: string,
  collapsed: boolean,
  directory = ''
): Promise<MemSidebarView> {
  const [stats, counts] = await Promise.all([
    WorkerClient.getStats(),
    WorkerClient.getProjectCounts(project),
  ])
  const capture = directory ? readCaptureStatus(directory) : null
  if (!stats) {
    return {
      healthy: false,
      capture,
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

  // Recent items are only rendered when expanded — skip the extra requests
  // while collapsed to keep the poll loop cheap.
  const [recentSummaries, recentObservations] = collapsed
    ? [[], []]
    : await Promise.all([
        WorkerClient.getRecentSummaries(project, RECENT_SUMMARIES),
        WorkerClient.getRecentObservations(project, RECENT_OBSERVATIONS),
      ])

  const totalObservations = readCount(stats.database?.observations)
  return {
    healthy: true,
    capture,
    project,
    scope: counts ? 'project' : 'all',
    totalObservations,
    observations: counts ? counts.observations : totalObservations,
    sessions: counts ? counts.sessions : readCount(stats.database?.sessions),
    summaries: counts ? counts.summaries : readCount(stats.database?.summaries),
    queueDepth: readCount(stats.processing?.queueDepth),
    isProcessing: stats.processing?.isProcessing === true,
    asOf: Math.floor(Date.now() / 60_000) * 60_000,
    recentSummaries,
    recentObservations,
  }
}

export interface MemDetail {
  readonly title: string
  readonly message: string
}

function field(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? decodeEntities(value).trim() : ''
}

/** `<item>` lists (summaries) or JSON string arrays (facts, files) as bullet lines. */
function listLines(value: string): string[] {
  const items = [...value.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((match) => match[1] ?? '')
  if (items.length > 0) {
    return items.map((item) => `• ${item.trim()}`)
  }
  if (value.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(value)
      if (Array.isArray(parsed)) {
        return parsed.filter((item) => typeof item === 'string').map((item) => `• ${item}`)
      }
    } catch {
      // Not JSON: show the text as written.
    }
  }
  return value ? [value] : []
}

function section(heading: string, lines: readonly string[]): string[] {
  return lines.length > 0 ? ['', heading, ...lines] : []
}

function formatTime(record: Record<string, unknown>): string {
  const at = record['created_at_epoch']
  return typeof at === 'number' && Number.isFinite(at) ? new Date(at).toLocaleString() : ''
}

/** Dialog text for one observation or session summary; null when the Worker has none. */
export function describeDetail(
  kind: RecentItemKind,
  id: number,
  record: Record<string, unknown> | null
): MemDetail | null {
  if (!record) {
    return null
  }
  const meta = [kind === 'observation' ? field(record, 'type') : 'session', formatTime(record)]
  if (kind === 'observation') {
    return {
      title: `#${id} ${field(record, 'title')}`.trim(),
      message: [
        field(record, 'subtitle'),
        ...section('Narrative', listLines(field(record, 'narrative'))),
        ...section('Facts', listLines(field(record, 'facts'))),
        ...section('Files modified', listLines(field(record, 'files_modified'))),
        '',
        [...meta, `get_observations([${id}])`].filter(Boolean).join(' · '),
      ]
        .join('\n')
        .trim(),
    }
  }
  return {
    title: field(record, 'request') || `Session #${id}`,
    message: [
      ...section('Investigated', listLines(field(record, 'investigated'))),
      ...section('Learned', listLines(field(record, 'learned'))),
      ...section('Completed', listLines(field(record, 'completed'))),
      ...section('Next steps', listLines(field(record, 'next_steps'))),
      ...section('Notes', listLines(field(record, 'notes'))),
      '',
      [...meta, `#${id}`].filter(Boolean).join(' · '),
    ]
      .join('\n')
      .trim(),
  }
}

export async function readDetail(kind: RecentItemKind, id: number): Promise<MemDetail | null> {
  return describeDetail(kind, id, await WorkerClient.getDetail(kind, id))
}
