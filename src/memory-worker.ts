import { MAX_OBSERVATION_BYTES, stripTaggedContent } from './shared'
import type { InjectionOptions } from './memory-options'
import { getWorkerBaseUrl } from './worker-client'
import { z } from 'zod'

const saveInput = z.object({
  text: z.string().min(1).max(MAX_OBSERVATION_BYTES),
  title: z.string().max(MAX_OBSERVATION_BYTES).optional(),
  project: z.string().trim().min(1).max(1000).optional(),
})
const saveResponse = z.object({
  success: z.literal(true),
  id: z.number().int().positive(),
  title: z.string(),
  project: z.string(),
  message: z.string(),
})
const semanticResponse = z.object({ context: z.string(), count: z.number().int().nonnegative() })
const fileResponse = z.object({
  observations: z.array(
    z.object({
      id: z.number().int().positive(),
      title: z.string().nullable(),
      type: z.string(),
      created_at_epoch: z.number().finite(),
      memory_session_id: z.string().nullable().optional(),
    })
  ),
  count: z.number().int().nonnegative(),
})
export type FileObservation = z.infer<typeof fileResponse>['observations'][number]

// Requests deliberately have no automatic retry: manual saves are non-idempotent.
// oxlint-disable-next-line typescript/no-extraneous-class
export class MemoryWorker {
  private static readonly baseUrl = getWorkerBaseUrl()

  private static async json(path: string, init: RequestInit): Promise<unknown> {
    try {
      const response = await fetch(`${this.baseUrl}${path}`, init)
      if (!response.ok) {
        return null
      }
      // Bound optional enrichment responses before parsing. A broken Worker must
      // not allocate unbounded history in the OpenCode process.
      const reader = response.body?.getReader()
      if (!reader) {
        return null
      }
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          // Sequential streaming enforces a hard response budget.
          // oxlint-disable-next-line no-await-in-loop
          const { done, value } = await reader.read()
          if (done) {
            break
          }
          size += value.byteLength
          if (size > 512 * 1024) {
            return null
          }
          chunks.push(value)
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } finally {
        await reader.cancel()
      }
    } catch {
      // Network, old endpoint, malformed JSON and timeout all fail open.
      return null
    }
  }

  static async save(input: unknown, project: string): Promise<string> {
    const parsed = saveInput.safeParse(input)
    if (!parsed.success) {
      return 'Memory not saved: invalid or oversized input.'
    }
    const text = stripTaggedContent(parsed.data.text)
    const title =
      parsed.data.title === undefined ? undefined : stripTaggedContent(parsed.data.title)
    if (
      !text ||
      (title !== undefined && !title) ||
      Buffer.byteLength(text) > MAX_OBSERVATION_BYTES ||
      (title !== undefined && Buffer.byteLength(title) > MAX_OBSERVATION_BYTES)
    ) {
      return 'Memory not saved: content is empty, private, or exceeds 24 KiB.'
    }
    const result = saveResponse.safeParse(
      await this.json('/api/memory/save', {
        method: 'POST',
        signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          title,
          project: parsed.data.project ?? project,
          metadata: { platformSource: 'opencode' },
        }),
      })
    )
    return result.success
      ? JSON.stringify(result.data)
      : 'Memory save not confirmed. The Worker may be unavailable or unsupported; check before retrying to avoid duplicates.'
  }

  static async semantic(
    prompt: string,
    project: string,
    options: InjectionOptions
  ): Promise<string> {
    const q = stripTaggedContent(prompt)
    if (!options.enabled || q.length < 20) {
      return ''
    }
    const result = semanticResponse.safeParse(
      await this.json('/api/context/semantic', {
        method: 'POST',
        signal: AbortSignal.timeout(options.timeoutMs),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q, project, limit: options.limit }),
      })
    )
    return result.success ? stripTaggedContent(result.data.context).slice(0, options.maxChars) : ''
  }

  static async byFile(
    paths: readonly string[],
    project: string,
    options: InjectionOptions
  ): Promise<readonly FileObservation[]> {
    const lookahead = Math.max(40, options.limit)
    const params = new URLSearchParams({ projects: project, limit: String(lookahead) })
    for (const path of new Set(paths.map((item) => item.replaceAll('\\', '/')))) {
      params.append('path', path)
    }
    const result = fileResponse.safeParse(
      await this.json(`/api/observations/by-file?${params}`, {
        signal: AbortSignal.timeout(options.timeoutMs),
      })
    )
    return result.success ? result.data.observations.slice(0, lookahead) : []
  }
}
