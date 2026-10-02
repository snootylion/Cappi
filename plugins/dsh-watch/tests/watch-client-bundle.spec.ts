/**
 * Built watch client bundle activation (server scope: node:fs/vm types).
 *
 * Proves the REAL `lib/client.js` artifact (tsdown browser CJS wrapped in
 * `window.__ModuleLoader__.load({ id: "dsh-watch", ... })`) activates: the
 * factory resolves against stubbed externals, `typeof apply` is a function,
 * and driving `apply()` with a fake host ctx registers the Watch section
 * whose panel component renders to static markup (DOM proof without a
 * browser — no auth provider is required for this structural proof).
 *
 * Isolated: reads only the repo-built bundle, no HOME/DSH_HOME/network.
 * Skips honestly when `lib/client.js` was not built (run `pnpm build`).
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import * as React from 'react'
import * as JsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.resolve(here, '../lib/client.js')
const built = existsSync(bundlePath)

type BundleExports = Record<string, unknown>

function loadBundle(): { exports: BundleExports; required: string[] } {
  const code = readFileSync(bundlePath, 'utf8')
  expect(code).toContain('id: "dsh-watch"')
  let loaded: { id: string; factory: (require: (id: string) => unknown) => BundleExports } | undefined
  const sandbox: Record<string, unknown> = {
    window: {
      __ModuleLoader__: {
        load: (payload: { id: string; factory: (require: (id: string) => unknown) => BundleExports }) => {
          loaded = payload
        },
      },
    },
  }
  vm.createContext(sandbox)
  const required: string[] = []
  const fakeRequire = (id: string): unknown => {
    required.push(id)
    if (id === 'react') return React
    if (id === 'react/jsx-runtime') return JsxRuntime
    throw new Error(`unexpected external ${id}`)
  }
  vm.runInContext(code, sandbox)
  if (!loaded) throw new Error('ModuleLoader.load was not called by lib/client.js')
  expect(loaded.id).toBe('dsh-watch')
  return { exports: loaded.factory(fakeRequire), required }
}

function fakeCtx(registered: Array<{ options: Record<string, unknown>; component: unknown }>) {
  return {
    effect: () => () => undefined,
    slots: {
      inject: (_slot: string, factory: () => unknown) => factory(),
      register: (options: Record<string, unknown>, component: unknown) => {
        registered.push({ options, component })
        return () => undefined
      },
    },
  }
}

describe('built watch client bundle (ModuleLoader id dsh-watch)', () => {
  it.skipIf(!built)('loads with id "dsh-watch", keeps SDK externals external, exports apply()', () => {
    const { exports, required } = loadBundle()
    expect(required).toContain('react')
    expect(required).not.toContain('@deepseek-ai/dsh-client-connection')
    expect(required).not.toContain('@deepseek-ai/dsh-client-ui-settings')
    expect(typeof exports['apply']).toBe('function')
    expect(exports['inject']).toEqual(['slots'])
    expect(exports['name']).toBe('dsh-watch-client')
  })

  it.skipIf(!built)('apply() registers the Watch settings.section entry', () => {
    const { exports } = loadBundle()
    const registered: Array<{ options: Record<string, unknown>; component: unknown }> = []
    ;(exports['apply'] as (ctx: unknown) => void)(fakeCtx(registered))
    expect(registered).toHaveLength(1)
    expect(registered[0]!.options).toMatchObject({ name: 'settings.section', id: 'watch', order: 15 })
    expect((registered[0]!.options['label'] as () => string)()).toBe('Watch')
    expect(typeof registered[0]!.component).toBe('function')
  })

  it.skipIf(!built)('registered panel renders to static markup (DOM proof without a browser)', () => {
    const { exports } = loadBundle()
    const registered: Array<{ options: Record<string, unknown>; component: unknown }> = []
    ;(exports['apply'] as (ctx: unknown) => void)(fakeCtx(registered))
    const component = registered[0]!.component
    const html = renderToStaticMarkup(React.createElement(component as never))
    expect(html).toContain('Watch')
  })
})
