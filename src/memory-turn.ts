import { extractTextFromParts, stripTaggedContent, truncateUtf8Bytes } from './shared'
import { z } from 'zod'

export interface MemoryTurn {
  readonly id: string
  readonly text: string
  readonly capture: boolean
  readonly semantic: boolean
}

export function memoryTurn(id: string, text: string, media = false): MemoryTurn {
  const cleaned = stripTaggedContent(
    text.replace(
      /<(system-reminder|system_instruction|system-instruction|persisted-output)\b[^>]*>[\s\S]*?<\/\1>/gi,
      ''
    )
  )
  const internal = /^\s*<task-notification\b[^>]*>[\s\S]*?<\/task-notification>\s*$/i.test(text)
  return {
    id,
    text: truncateUtf8Bytes(cleaned || (media ? '[media prompt]' : ''), 256 * 1024),
    capture: !internal && (Boolean(cleaned) || (media && !text.trim())),
    semantic: !internal && cleaned.length >= 20,
  }
}

const deliveredRecord = z.object({
  id: z.string(),
  type: z.string(),
  text: z.string().optional(),
  files: z.array(z.unknown()).optional(),
  metadata: z
    .object({ synthetic: z.boolean().optional(), agentId: z.string().optional() })
    .optional(),
})

/** Only consumed session context, never the admission/inbox list. */
export function deliveredTurn(messages: readonly unknown[]): MemoryTurn | undefined {
  for (const raw of messages.toReversed()) {
    const parsed = deliveredRecord.safeParse(raw)
    if (parsed.success) {
      const message = parsed.data
      if (message.type === 'synthetic') {
        return { id: message.id, text: '', capture: false, semantic: false }
      }
      if (message.type === 'user') {
        if (message.metadata?.synthetic || message.metadata?.agentId) {
          return { id: message.id, text: '', capture: false, semantic: false }
        }
        return memoryTurn(message.id, message.text ?? '', Boolean(message.files?.length))
      }
    }
  }
  return undefined
}

const v1Record = z.object({
  info: z.object({ id: z.string(), role: z.string() }),
  parts: z.array(z.unknown()),
})
export function resumedV1Turn(messages: unknown): MemoryTurn | undefined {
  if (!Array.isArray(messages)) {
    return undefined
  }
  for (const raw of messages.toReversed()) {
    const parsed = v1Record.safeParse(raw)
    if (parsed.success && parsed.data.info.role === 'user') {
      return memoryTurn(
        parsed.data.info.id,
        extractTextFromParts(parsed.data.parts),
        parsed.data.parts.some(
          (part) =>
            typeof part === 'object' && part !== null && 'type' in part && part.type === 'file'
        )
      )
    }
  }
  return undefined
}
