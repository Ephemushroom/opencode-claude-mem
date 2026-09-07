import { relative, resolve } from 'node:path'
import type { InjectionOptions } from './memory-options'
import { MemoryWorker } from './memory-worker'
import { stat } from 'node:fs/promises'
import { stripTaggedContent } from './shared'
import { z } from 'zod'

const readInput = z
  .object({
    filePath: z.string().optional(),
    file_path: z.string().optional(),
    filePaths: z.array(z.string()).optional(),
    file_paths: z.array(z.string()).optional(),
    path: z.string().optional(),
  })
  .passthrough()

export class FileContext {
  private readonly sessions = new Map<string, Map<string, string>>()
  private readonly options: InjectionOptions
  private readonly worker: typeof MemoryWorker
  constructor(options: InjectionOptions, worker = MemoryWorker) {
    this.options = options
    this.worker = worker
  }

  async read(
    session: string,
    input: { readonly tool: string; readonly args: unknown },
    location: { readonly directory: string; readonly project: string }
  ): Promise<string> {
    if (!this.options.enabled || !/(?:^|[._-])read(?:_file|_files)?$/i.test(input.tool)) {
      return ''
    }
    const parsed = readInput.safeParse(input.args)
    if (!parsed.success) {
      return ''
    }
    const args = parsed.data
    const paths = [
      ...new Set(
        [
          args.filePath,
          args.file_path,
          args.path,
          ...(args.filePaths ?? []),
          ...(args.file_paths ?? []),
        ].filter((path) => path !== undefined)
      ),
    ].slice(0, 10)
    let seen = this.sessions.get(session)
    if (!seen) {
      seen = new Map()
      this.sessions.set(session, seen)
    }
    const revisions = seen
    const attempted = new Map<string, string>()
    const deadline = Date.now() + this.options.timeoutMs
    let active = true
    const timeout = Promise.withResolvers<string>()
    const timer = setTimeout(() => timeout.resolve(''), this.options.timeoutMs)
    const pending = (async () => {
      // Parallel requests share one per-read deadline, not ten serial timeouts.
      const results = await Promise.all(
        paths.map(async (path) => {
          const absolute = resolve(location.directory, path)
          const file = await stat(absolute).catch(() => null)
          if (
            !active ||
            this.sessions.get(session) !== revisions ||
            !file?.isFile() ||
            file.size < 1500
          ) {
            return []
          }
          const revision = `${file.mtimeMs}:${file.size}`
          const inFlight = `pending:${revision}`
          if (revisions.get(absolute) === revision || revisions.get(absolute) === inFlight) {
            return []
          }
          attempted.set(absolute, inFlight)
          revisions.set(absolute, inFlight)
          const rows = await this.worker.byFile(
            [absolute, relative(location.directory, absolute)],
            location.project,
            { ...this.options, timeoutMs: Math.max(1, deadline - Date.now()) }
          )
          if (
            !active ||
            this.sessions.get(session) !== revisions ||
            !rows.length ||
            file.mtimeMs >= Math.max(...rows.map((row) => row.created_at_epoch))
          ) {
            return []
          }
          return rows.map((row) => ({ row, path: absolute, revision }))
        })
      )
      const sessions = new Set<string>()
      const selected = results
        .flat()
        .toSorted((a, b) => b.row.created_at_epoch - a.row.created_at_epoch)
        .filter(({ row }) => {
          const key = row.memory_session_id ?? `observation:${row.id}`
          if (sessions.has(key)) {
            return false
          }
          sessions.add(key)
          return true
        })
        .slice(0, this.options.limit)
      const delivered = new Map<string, string>()
      let text = ''
      for (const { row, path, revision } of selected) {
        const separator = text ? '\n' : ''
        const available = this.options.maxChars - text.length - separator.length
        if (available <= 0) {
          break
        }
        const line = `#${row.id} ${stripTaggedContent(row.type)}: ${stripTaggedContent(row.title ?? '')}`
        text += separator + line.slice(0, available)
        delivered.set(path, revision)
      }
      if (text && active && this.sessions.get(session) === revisions) {
        for (const [path, revision] of delivered) {
          revisions.set(path, revision)
        }
      }
      return text
        ? `\n\n<claude-mem-context>\nSupplementary file history (past observations, not file contents):\n${text}\n</claude-mem-context>`
        : ''
    })()
    try {
      return await Promise.race([pending, timeout.promise])
    } catch {
      return ''
    } finally {
      active = false
      clearTimeout(timer)
      // Failed or timed-out attempts are retryable on a later read. Only delivered
      // history consumes a revision; late requests cannot change this generation.
      for (const [path, revision] of attempted) {
        if (revisions.get(path) === revision) {
          revisions.delete(path)
        }
      }
    }
  }
  delete(session: string): void {
    this.sessions.delete(session)
  }
  clear(): void {
    this.sessions.clear()
  }
}
