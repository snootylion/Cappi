// Strict JSON grammar with duplicate-key rejection (including escaped aliases).
// Strings are scanned, never searched with a structural regex. Errors never echo input.
const bad = (status = 400, message = 'bad json') => Object.assign(new Error(message), { status })
export function parseStrictJson (text, { flat = false } = {}) {
  let i = 0
  const ws = () => { while (' \t\r\n'.includes(text[i]) && i < text.length) i++ }
  function string () {
    const start = i++
    while (i < text.length) {
      const c = text[i++]
      if (c === '"') { try { return JSON.parse(text.slice(start, i)) } catch { throw bad() } }
      if (c === '\\') {
        const e = text[i++]
        if (e === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i, i + 4))) throw bad()
          i += 4
        } else if (!['"', '\\', '/', 'b', 'f', 'n', 'r', 't'].includes(e)) throw bad()
      } else if (c.charCodeAt(0) < 32) throw bad()
    }
    throw bad()
  }
  function value (depth) {
    if (depth > 32) throw bad()
    ws()
    if (text[i] === '"') { string(); return }
    if (text[i] === '{') {
      if (flat && depth > 0) throw bad()
      i++; ws(); const keys = new Set()
      if (text[i] === '}') { i++; return }
      while (true) {
        ws(); if (text[i] !== '"') throw bad()
        const key = string()
        if (keys.has(key)) throw bad(400, 'duplicate json key')
        keys.add(key); ws(); if (text[i++] !== ':') throw bad()
        value(depth + 1); ws()
        const end = text[i++]
        if (end === '}') return
        if (end !== ',') throw bad()
      }
    }
    if (text[i] === '[') {
      if (flat) throw bad()
      i++; ws(); if (text[i] === ']') { i++; return }
      while (true) {
        value(depth + 1); ws(); const end = text[i++]
        if (end === ']') return
        if (end !== ',') throw bad()
      }
    }
    const m = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(i))
    if (!m) throw bad()
    i += m[0].length
  }
  ws(); if (text[i] !== '{') throw bad()
  value(0); ws(); if (i !== text.length) throw bad()
  try { return JSON.parse(text) } catch { throw bad() }
}

/** HTTP JSON gate shared by commands/cappi; PCM uploads never call this. */
export function readJson (req, limit = 1 << 20, options = {}) {
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(String(req.headers['content-type'] || ''))) {
    req.resume()
    return Promise.reject(bad(415, 'application/json required'))
  }
  return new Promise((resolve, reject) => {
    let size = 0; let oversized = false; const parts = []
    req.on('data', d => {
      size += d.length
      if (size > limit) { oversized = true; parts.length = 0; return }
      if (!oversized) parts.push(d)
    })
    req.on('end', () => {
      if (oversized) { reject(bad(413, 'json body too large')); return }
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))
        resolve(parseStrictJson(text, options))
      } catch { reject(bad()) }
    })
    req.on('error', () => reject(bad()))
  })
}
