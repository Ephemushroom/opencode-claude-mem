import type { MemoryOptions } from './memory-options'
import type { MemoryTurn } from './memory-turn'
import { MemoryWorker } from './memory-worker'
import { WorkerClient } from './worker-client'
import { stripTaggedContent } from './shared'

/** Mutable state is scoped to one session incarnation, never reused after deletion. */
interface SessionState {
  current?: MemoryTurn
  readonly turns: Map<string, MemoryTurn>
  readonly registered: Set<string>
  readonly blocked: Set<string>
  readonly pending: MemoryTurn[]
  registration?: Promise<boolean>
  readonly semantic: Map<string, Promise<string>>
  context?: Promise<string | null>
}

export class MemorySessions {
  private readonly sessions = new Map<string, SessionState>()
  private readonly deleted = new Set<string>()
  private readonly options: MemoryOptions
  private readonly worker: typeof MemoryWorker
  constructor(options: MemoryOptions, worker = MemoryWorker) {
    this.options = options
    this.worker = worker
  }

  private state(id: string): SessionState {
    let state = this.sessions.get(id)
    if (!state) {
      state = {
        turns: new Map(),
        registered: new Set(),
        blocked: new Set(),
        pending: [],
        semantic: new Map(),
      }
      this.sessions.set(id, state)
    }
    return state
  }

  select(session: string, turn: MemoryTurn): boolean {
    if (this.isDeleted(session)) {
      return false
    }
    const state = this.state(session)
    const known = state.turns.get(turn.id)
    if (known && state.current !== known) {
      return false
    }
    state.current = known ?? turn
    if (!known) {
      state.turns.set(turn.id, turn)
      if (turn.capture) {
        state.pending.push(turn)
      }
    }
    return !known
  }

  hasTurn(session: string): boolean {
    return Boolean(this.sessions.get(session)?.current)
  }

  hasMessage(session: string, id: string): boolean {
    return this.sessions.get(session)?.turns.has(id) ?? false
  }

  isDeleted(session: string): boolean {
    return this.deleted.has(session)
  }

  canCapture(session: string): boolean {
    const state = this.sessions.get(session)
    const turn = state?.current
    return Boolean(turn?.capture && state?.registered.has(turn.id) && !state.blocked.has(turn.id))
  }

  async register(session: string, project: string): Promise<boolean> {
    const state = this.sessions.get(session)
    if (!state?.current?.capture) {
      return false
    }
    if (state.registration) {
      return state.registration
    }
    const pending = (async () => {
      while (state.pending.length) {
        const [turn] = state.pending
        if (!turn || this.sessions.get(session) !== state) {
          return false
        }
        // Registration is intentionally serial: the Worker owns the current prompt number.
        // oxlint-disable-next-line no-await-in-loop
        const result = await WorkerClient.sessionInit(session, project, turn.text)
        if (!result || this.sessions.get(session) !== state) {
          return false
        }
        if (result.skipped && result.reason !== 'duplicate') {
          state.blocked.add(turn.id)
        }
        state.registered.add(turn.id)
        state.pending.shift()
      }
      return this.canCapture(session)
    })()
    state.registration = pending
    try {
      return await pending
    } finally {
      state.registration = undefined
    }
  }

  async semantic(session: string, project: string): Promise<string> {
    const state = this.sessions.get(session)
    const turn = state?.current
    if (!state || !turn?.semantic || !this.canCapture(session)) {
      return ''
    }
    let pending = state.semantic.get(turn.id)
    if (!pending) {
      pending = this.worker.semantic(turn.text, project, this.options.semanticInjection)
      state.semantic.set(turn.id, pending)
    }
    const result = await pending
    return this.sessions.get(session) === state && state.current === turn ? result : ''
  }

  async context(session: string, project: string): Promise<string | null> {
    if (this.isDeleted(session)) {
      return null
    }
    const state = this.state(session)
    if (!state.context) {
      state.context = WorkerClient.getContext(project)
    }
    const pending = state.context
    const value = await pending
    if (this.sessions.get(session) !== state || state.context !== pending) {
      return null
    }
    if (value === null) {
      state.context = undefined
    }
    return value === null ? null : stripTaggedContent(value).slice(0, 24000)
  }

  invalidate(session: string): void {
    const state = this.sessions.get(session)
    if (state) {
      state.context = undefined
    }
  }
  delete(session: string): void {
    this.deleted.add(session)
    this.sessions.delete(session)
  }
  clear(): void {
    for (const session of this.sessions.keys()) {
      this.deleted.add(session)
    }
    this.sessions.clear()
  }
}
