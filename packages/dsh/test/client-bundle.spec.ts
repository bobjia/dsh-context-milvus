import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * client/client.js is shipped verbatim (it is not built from TypeScript and no
 * other spec touches it), so a stale service name or slot seat here only ever
 * shows up as a silent failure in the browser: the entry stays inactive and the
 * settings form never renders. It is a hand-rolled module-loader bundle, so we
 * can activate it headlessly by supplying the loader and `require` ourselves.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.resolve(HERE, '../client/client.js')

const source = readFileSync(CLIENT, 'utf-8')

const NS = 'dsh-context-milvus'

/** The bundle's whole host dependency surface: Fragment + useState + jsx. */
function fakeRequire(name: string): unknown {
  if (name === 'react') {
    return { Fragment: Symbol('Fragment'), useState: (initial: unknown) => [initial, () => {}] }
  }
  if (name === 'react/jsx-runtime') {
    return { jsx: (...args: unknown[]) => args, jsxs: (...args: unknown[]) => args }
  }
  throw new Error(`client bundle required an unexpected module: ${name}`)
}

interface Captured {
  id: string
  factory: (require: (name: string) => unknown) => any
}

/** Evaluate the bundle and hand back its exported plugin module. */
function loadBundle(): { module: any; captured: Captured; calls: Record<string, any[]> } {
  let captured!: Captured
  // `window` is the bundle's only global (one reference, at the top level), so
  // hand it in as a parameter rather than polluting globalThis.
  const load = new Function('window', source)
  load({ __ModuleLoader__: { load: (mod: Captured) => { captured = mod } } })

  const calls: Record<string, any[]> = {
    localeRegister: [], formGet: [], whileServed: [], slotsInject: [], slotsRegister: [],
  }
  const disposers: Array<() => void> = []
  const form = {
    getSnapshot: () => ({ status: 'ready', value: {}, base: {}, user: {}, writable: true, revision: 1 }),
    subscribe: () => () => {},
    set: async () => true,
    unset: async () => true,
  }
  const ctx: any = {
    // cordis runs an effect immediately and keeps its disposer.
    effect: (fn: () => any) => { const d = fn(); if (typeof d === 'function') disposers.push(d); return d },
    locale: {
      register: (ns: string) => { calls.localeRegister.push(ns); return () => {} },
      bind: (ns: string) => (key: string) => `${ns}:${key}`,
    },
    configForms: {
      get: (ns: string) => { calls.formGet.push(ns); return form },
      // Register only while the host serves the namespace, exactly as the
      // harness does: run the registration now and hand back its disposer.
      whileServed: (namespaces: string[], register: (served: ReadonlySet<string>) => () => void) => {
        calls.whileServed.push(namespaces)
        return register(new Set(namespaces))
      },
    },
    slots: {
      inject: (seat: string, cb: () => any) => { calls.slotsInject.push(seat); return cb() },
      register: (options: any, component: unknown) => {
        calls.slotsRegister.push({ options, component })
        return () => {}
      },
    },
  }

  const module = captured.factory(fakeRequire)
  module.apply(ctx)
  return { module, captured, calls }
}

describe('dsh client bundle — source pins', () => {
  it('injects configForms, the dsh-settings ≥0.1.7 client transport', () => {
    const inject = source.match(/var inject = (\[[^\]]*\]);/)
    expect(inject).not.toBeNull()
    expect(JSON.parse(inject![1])).toEqual(['slots', 'locale', 'configForms'])
    expect(source).not.toMatch(/ctx\.settingsScope/)
  })

  it('registers its card in the plugins.item seat the current core renders', () => {
    expect(source).toMatch(/ctx\.slots\.inject\("plugins\.item"/)
    expect(source).toMatch(/name: "plugins\.item"/)
    // The pre-0.1.6 seat is no longer rendered, so a card registered there would
    // be invisible. Match the code forms only — the comments explain the move.
    expect(source).not.toMatch(/ctx\.slots\.inject\("settings\.plugin\.item"/)
    expect(source).not.toMatch(/name: "settings\.plugin\.item"/)
  })

  it('gates the card on the host serving the namespace', () => {
    // Registers only while the Host actually serves our namespace, so a
    // deployment without the plugin loaded shows no trace of the card.
    expect(source).toMatch(/configForms\.whileServed\(\[NS\]/)
  })
})

describe('dsh client bundle — activation', () => {
  it('activates against the 0.1.7 client services and registers its card', () => {
    // The regression this guards: the entry used to declare `settingsScope`,
    // which 0.1.7 removed, so activation never happened and the plugin sat
    // "pending (waiting for service: settingsScope)" with no settings form.
    const { module, captured, calls } = loadBundle()

    expect(captured.id).toBe(NS)
    expect(module.inject).toEqual(['slots', 'locale', 'configForms'])

    // Bound the form to our namespace (= the composition entry id).
    expect(calls.formGet).toEqual([NS])
    expect(calls.whileServed).toEqual([[NS]])

    // Registered into the seat the current core renders, keyed and labelled.
    expect(calls.slotsInject).toEqual(['plugins.item'])
    expect(calls.slotsRegister).toHaveLength(1)
    const { options, component } = calls.slotsRegister[0]
    expect(options.name).toBe('plugins.item')
    expect(options.id).toBe(NS)
    expect(options.locale).toBe(NS)
    expect(options.label()).toBe(`${NS}:title`)
    expect(component).toBeDefined()

    // The card's action bag is what the form component consumes.
    const injected = options.inject()
    for (const action of ['edit', 'resetField', 'save', 'discard']) {
      expect(typeof injected[action]).toBe('function')
    }
    expect(injected.hooks.milvusConfigCard).toBeDefined()

    // Locale dictionaries are registered under the same namespace.
    expect(calls.localeRegister).toEqual([NS])
  })
})
