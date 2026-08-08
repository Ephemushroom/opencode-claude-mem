import {
  POLL_INTERVAL_MS,
  type ViewNode,
  buildMemNodes,
  readMemView,
  viewKey,
} from './sidebar-model'

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
