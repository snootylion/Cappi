import type { IncomingMessage } from 'node:http'

/** HTTP only: helper JSON-lines intentionally retain their independent parser. */
export async function readHttpJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > 64 * 1024) throw new RangeError('request body too large')
    chunks.push(buffer)
  }
  return parseHttpJsonObject(Buffer.concat(chunks).toString('utf8'))
}

/** Reject ambiguous (including escaped/nested) duplicate keys, with bounded depth. */
export function parseHttpJsonObject(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text) > 64 * 1024) throw new RangeError('request body too large')
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid JSON object')
  let at = 0
  const space = () => { while (/\s/u.test(text[at] ?? '') && at < text.length) at++ }
  const string = (): string => {
    const start = at++
    while (at < text.length) {
      const char = text[at++]
      if (char === '\\') at++
      else if (char === '"') return JSON.parse(text.slice(start, at)) as string
    }
    throw new Error('invalid JSON string')
  }
  const scan = (depth: number): void => {
    if (depth > 64) throw new Error('JSON nesting too deep')
    space()
    if (text[at] === '{') {
      at++; space()
      const keys = new Set<string>()
      while (text[at] !== '}') {
        const key = string()
        if (keys.has(key)) throw new Error('duplicate JSON key')
        keys.add(key); space(); at++; scan(depth + 1); space()
        if (text[at] !== ',') break
        at++; space()
      }
      at++
    } else if (text[at] === '[') {
      at++; space()
      while (text[at] !== ']') {
        scan(depth + 1); space()
        if (text[at] !== ',') break
        at++; space()
      }
      at++
    } else if (text[at] === '"') string()
    else { while (at < text.length && !/[\s,}\]]/u.test(text[at]!)) at++ }
  }
  scan(0)
  return value as Record<string, unknown>
}
