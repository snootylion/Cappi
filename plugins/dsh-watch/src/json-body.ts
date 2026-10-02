import type { IncomingMessage } from 'node:http';

/** JSON.parse alone silently accepts duplicate keys. Scan string tokens once;
 * reject duplicates at every object level, including escaped-equivalent keys. */
export function parseStrictObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON object required');
  const stack: Array<Set<string> | null> = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') stack.push(new Set());
    else if (ch === '[') stack.push(null);
    else if (ch === '}' || ch === ']') stack.pop();
    else if (ch === '"') {
      const start = i++;
      while (i < text.length) {
        if (text[i] === '\\') i += 2;
        else if (text[i] === '"') break;
        else i++;
      }
      let j = i + 1;
      while (/\s/.test(text[j] ?? '') && j < text.length) j++;
      if (text[j] === ':') {
        const keys = stack.at(-1);
        const key = JSON.parse(text.slice(start, i + 1)) as string;
        if (keys?.has(key)) throw new Error('duplicate JSON field');
        keys?.add(key);
      }
    }
  }
  return value as Record<string, unknown>;
}
export function readJsonBody(req: Pick<IncomingMessage, 'on' | 'headers' | 'rawHeaders'>, limit = 16 * 1024): Promise<Record<string, unknown>> {
  const types = (req.rawHeaders ?? []).filter((_, i) => i % 2 === 0).filter(k => k.toLowerCase() === 'content-type');
  if (types.length > 1 || typeof req.headers['content-type'] !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'])) {
    return Promise.reject(Object.assign(new Error('application/json content-type required'), { status: 415 }));
  }
  return new Promise((resolve, reject) => {
    let size = 0; let failed = false;
    const parts: Buffer[] = [];
    req.on('data', (part: Buffer) => {
      if (failed) return;
      size += part.length;
      if (size > limit) { failed = true; parts.length = 0; reject(Object.assign(new Error('JSON body too large'), { status: 413 })); return; }
      parts.push(part);
    });
    req.on('end', () => {
      if (failed) return;
      try { resolve(parseStrictObject(Buffer.concat(parts).toString('utf8'))); }
      catch (e) { reject(Object.assign(new Error((e as Error).message || 'bad JSON'), { status: 400 })); }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(Object.assign(new Error('body aborted'), { status: 400 })));
  });
}
