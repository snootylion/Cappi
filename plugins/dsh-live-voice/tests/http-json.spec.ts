import { describe, expect, it } from 'vitest'
import { parseHttpJsonObject } from '../src/http-json.ts'

describe('bounded unambiguous HTTP JSON (not helper JSON-lines)', () => {
  it('keeps ordinary nested JSON, arrays, escaped quotes and independent sibling keys', () => {
    const value = { command: 'stop', patch: { voice: 'a"b\\c' }, data: [1, null, true, { voice: 'different' }], message: '"voice":"not a key"' }
    expect(parseHttpJsonObject(JSON.stringify(value))).toEqual(value)
  })
  it.each([
    '{"x":1,"x":2}', '{"x":1,"\\u0078":2}',
    '{"nested":{"x":1,"x":2}}', '{"data":[{"x":1,"x":2}]}',
  ])('rejects decoded duplicate keys at every depth: %s', (text) => {
    expect(() => parseHttpJsonObject(text)).toThrow(/duplicate JSON key/)
  })
  it('rejects excessive bytes and nesting, invalid JSON and non-object roots', () => {
    expect(() => parseHttpJsonObject(JSON.stringify({ text: 'x'.repeat(65536) }))).toThrow(RangeError)
    expect(() => parseHttpJsonObject('{"data":' + '['.repeat(65) + '0' + ']'.repeat(65) + '}')).toThrow(/nesting/)
    for (const text of ['[]', 'null', 'true', '{', '{"x":NaN}']) expect(() => parseHttpJsonObject(text)).toThrow()
  })
})
