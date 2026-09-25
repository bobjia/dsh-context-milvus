import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * client/client.js is shipped verbatim (it is not built from TypeScript and no
 * other spec touches it), so a stale service name or slot seat here only ever
 * shows up as a silent failure in the browser: the entry stays inactive, the
 * form renders in the wrong seat, or it renders twice. It is a hand-rolled
 * module-loader bundle, so we can activate AND render it headlessly by
 * supplying the loader, `require` and the slot owner's props ourselves.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.resolve(HERE, '../client/client.js')
const PLUGIN = path.resolve(HERE, '../src/plugins/dsh-context-milvus/index.ts')

const source = readFileSync(CLIENT, 'utf-8')

const NS = 'dsh-context-milvus'

/** The field id the form renders a Config key under. */
const FIELD_ID_PREFIX = `plugin-config-${NS}-`

/**
 * The Config keys the plugin's host half declares: the set of fields the form
 * has to cover. Same source scan as public-surface.spec.ts, which pins the same
 * list as the public contract — so a key added there and not here, or a control
 * drawn twice, fails right here.
 */
function configKeys(): string[] {
  const text = readFileSync(PLUGIN, 'utf-8')
  return [...text.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*):\s*z\./gm)].map(m => m[1])
}

interface JsxNode { readonly type: unknown; readonly props: Record<string, any> }

/** The bundle's whole host dependency surface: Fragment + jsx. */
function fakeRequire(name: string): unknown {
  if (name === 'react') {
    // Disclosures start expanded: a collapsed entry would hide its fields from
    // every assertion below, which is exactly how an entry that drew its form in
    // the wrong seat — or in two seats — stayed invisible to this harness.
    return { Fragment: Symbol('Fragment'), useState: () => [true, () => {}] }
  }
  if (name === 'react/jsx-runtime') {
    // Tagged nodes rather than the raw argument tuple: a node's `children` is an
    // array too, so only a tag tells the walker a node from a list of them.
    return {
      jsx: (type: unknown, props: unknown) => ({ type, props }),
      jsxs: (type: unknown, props: unknown) => ({ type, props }),
    }
  }
  throw new Error(`client bundle required an unexpected module: ${name}`)
}

/** Every `id` prop in a rendered tree, in render order. */
function idsOf(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) idsOf(child, found)
    return found
  }
  if (typeof node !== 'object' || node === null) return found
  const { props } = node as JsxNode
  if (typeof props?.id === 'string') found.push(props.id)
  return idsOf(props?.children, found)
}

/** Every string a rendered tree shows, in render order. */
function textOf(node: unknown, found: string[] = []): string[] {
  if (typeof node === 'string') { found.push(node); return found }
  if (Array.isArray(node)) { for (const child of node) textOf(child, found); return found }
  if (typeof node !== 'object' || node === null) return found
  return textOf((node as JsxNode).props?.children, found)
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

/** A form snapshot with every Config field present, as `apply`'s store builds it. */
function cardState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const state: Record<string, unknown> = {
    available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false,
    ...overrides,
  }
  for (const key of configKeys()) state[key] = { text: '', overridden: false, invalid: false }
  return state
}

/** The `t` the renderer hands a `locale: NS` entry, keeping the key visible. */
const t = (key: string): string => `${NS}:${key}`

/**
 * Render the registered entry the way the Plugins page renders it, and return
 * its rendered tree.
 */
function renderTree(view: 'summary' | 'page', overrides: Record<string, unknown> = {}, props: Record<string, unknown> = {}): any {
  const { calls } = loadBundle()
  const { options, component } = calls.slotsRegister[0]
  return component({
    ...options.inject(),
    t,
    useMilvusConfigCard: (select: (state: unknown) => unknown) => select(cardState(overrides)),
    view,
    ...props,
  })
}

/** The Config keys the entry drew a control for, in render order. */
function renderCard(view: 'summary' | 'page', overrides?: Record<string, unknown>): string[] {
  return idsOf(renderTree(view, overrides))
    .filter(id => id.startsWith(FIELD_ID_PREFIX))
    .map(id => id.slice(FIELD_ID_PREFIX.length))
}

describe('dsh client bundle — source pins', () => {
  it('injects configForms, the dsh-settings ≥0.1.7 client transport', () => {
    const inject = source.match(/var inject = (\[[^\]]*\]);/)
    expect(inject).not.toBeNull()
    expect(JSON.parse(inject![1])).toEqual(['slots', 'locale', 'configForms'])
    expect(source).not.toMatch(/ctx\.settingsScope/)
  })

  it('registers its form in the bundle seat the current core renders, keyed by package name', () => {
    expect(source).toMatch(/ctx\.slots\.inject\("plugins\.bundle\.config"/)
    expect(source).toMatch(/name: "plugins\.bundle\.config"/)
    expect(source).toMatch(/key: NS/)
    // `plugins.item` is the seat the harness's own settings pages occupy, and the
    // page renders it twice — once as the card one-liner, once as the body of the
    // plugin's page. A bundle's configuration belongs in `plugins.bundle.config`
    // (rendered `page` only, on the bundle's own page), which is also why the
    // entry needs no label: the page draws the title and description itself.
    expect(source).not.toMatch(/ctx\.slots\.inject\("plugins\.item"/)
    expect(source).not.toMatch(/name: "plugins\.item"/)
    // The pre-0.1.6 seat is no longer rendered, so a card registered there would
    // be invisible. Match the code forms only — the comments explain the move.
    expect(source).not.toMatch(/ctx\.slots\.inject\("settings\.plugin\.item"/)
    expect(source).not.toMatch(/name: "settings\.plugin\.item"/)
  })

  it('gates the form on the host serving the namespace', () => {
    // Registers only while the Host actually serves our namespace, so a
    // deployment without the plugin loaded shows no trace of the form.
    expect(source).toMatch(/configForms\.whileServed\(\[NS\]/)
  })
})

describe('dsh client bundle — activation', () => {
  it('activates against the 0.1.7 client services and registers its form', () => {
    // The regression this guards: the entry used to declare `settingsScope`,
    // which 0.1.7 removed, so activation never happened and the plugin sat
    // "pending (waiting for service: settingsScope)" with no settings form.
    const { module, captured, calls } = loadBundle()

    expect(captured.id).toBe(NS)
    expect(module.inject).toEqual(['slots', 'locale', 'configForms'])

    // Bound the form to our namespace (= the composition entry id).
    expect(calls.formGet).toEqual([NS])
    expect(calls.whileServed).toEqual([[NS]])

    // Registered into the seat the current core renders, keyed by package name.
    expect(calls.slotsInject).toEqual(['plugins.bundle.config'])
    expect(calls.slotsRegister).toHaveLength(1)
    const { options, component } = calls.slotsRegister[0]
    expect(options.name).toBe('plugins.bundle.config')
    expect(options.key).toBe(NS)
    expect(options.locale).toBe(NS)
    expect(component).toBeDefined()

    // The form's action bag is what the form component consumes.
    const injected = options.inject()
    for (const action of ['edit', 'resetField', 'save', 'discard']) {
      expect(typeof injected[action]).toBe('function')
    }
    expect(injected.hooks.milvusConfigCard).toBeDefined()

    // Locale dictionaries are registered under the same namespace.
    expect(calls.localeRegister).toEqual([NS])
  })
})

describe('dsh client bundle — rendered form', () => {
  it('draws every Config field exactly once in the page view', () => {
    const ids = renderCard('page')

    // The form covers the whole Config schema — no field left unconfigurable.
    expect([...ids].sort()).toEqual([...configKeys()].sort())
    // No field twice: the observable form of the bug where a field is drawn by
    // the generic field loop AND by a block of its own.
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('draws nothing in the summary view', () => {
    // The bug this guards: the component ignored `view` and drew its entire form
    // in every seat, so the Plugins page showed the same 27-field form twice —
    // once as the entry's one-liner and once as its page body.
    expect(renderCard('summary')).toEqual([])
  })

  it('says so while the host has not delivered the snapshot yet', () => {
    // Every control reads its value from the snapshot: with none, the form would
    // show 27 plausible-looking empty fields, which is worse than saying nothing.
    const tree = renderTree('page', { available: false })
    expect(idsOf(tree)).toEqual([])
    expect(textOf(tree)).toEqual([`${NS}:loading`])
  })
})
