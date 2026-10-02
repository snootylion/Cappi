import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { parseStrictJson, readJson } from './strict-json.mjs'

test('strict grammar rejects duplicates (escaped too), nested ambiguity and non-object roots', () => {
  for (const raw of ['{"cmd":"ping","cmd":"stop"}', '{"cmd":"ping","\\u0063md":"stop"}', '{"x":{"a":1,"a":2}}', '[]', 'null', '{"x":01}', '{"x":true,}', '{"x":1} trailing']) {
    assert.throws(() => parseStrictJson(raw))
  }
  assert.deepEqual(parseStrictJson('{"text":"quoted \\\"cmd\\\": and { braces }","choiceIds":["a","b"]}'), { text: 'quoted "cmd": and { braces }', choiceIds: ['a', 'b'] })
  assert.throws(() => parseStrictJson('{"x":[]}', { flat: true }))
  assert.throws(() => parseStrictJson('{"x":{}}', { flat: true }))
})

test('HTTP public JSON gate: content type, byte bound, fatal UTF-8 and duplicate rejection', async () => {
  const server = http.createServer(async (req, res) => {
    try { await readJson(req, 64); res.writeHead(200).end() }
    catch (e) { res.writeHead(e.status || 500).end(e.message) }
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const request = (body, type) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', headers: type ? { 'content-type': type } : {} }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode))
    }); req.on('error', reject); req.end(body)
  })
  try {
    assert.equal(await request('{}'), 415)
    assert.equal(await request('{}', 'text/plain'), 415)
    assert.equal(await request('{}', 'application/json; charset=utf-8'), 200)
    assert.equal(await request('{"cmd":1,"cmd":2}', 'application/json'), 400)
    assert.equal(await request(Buffer.from([123, 34, 120, 34, 58, 34, 0xff, 34, 125]), 'application/json'), 400)
    assert.equal(await request('x'.repeat(65), 'application/json'), 413)
  } finally { await new Promise(r => server.close(r)) }
})
