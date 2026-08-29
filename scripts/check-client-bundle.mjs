/**
 * Verify client/client.js materializes like the DSH client module system does.
 *
 * The DSH web boot loads each plugin's browser bundle through
 * `window.__ModuleLoader__.load({id, factory})`, then materializes the factory
 * (running its body) to obtain the module's exports. Materialization must not
 * throw, and the module must export an `apply(ctx)` — `ctx` is only available
 * as the param of that function, never at factory body scope.
 *
 * Usage: node scripts/check-client-bundle.mjs
 * Exit code 0 = bundle materializes and exports apply; non-zero = broken.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'client', 'client.js')

// Seed-module stubs. The factory only requires these at module scope; the
// real UI is only touched inside render functions, which we never call here.
const seeds = {
  'react': {},
  'react/jsx-runtime': {},
  '@deepseek-ai/dsh-client-ui-slots': {},
}

let registration = null
const prevWindow = globalThis.window
globalThis.window = globalThis
globalThis.window.__ModuleLoader__ = {
  load(reg) {
    registration = reg
  },
}

try {
  // 1. Evaluate the bundle — it must call window.__ModuleLoader__.load({id, factory}).
  const code = readFileSync(bundlePath, 'utf8')
  try {
    // Run like a <script>: eval in module-ish scope. `window` resolves via globalThis.
    (0, eval)(code)
  } catch (err) {
    throw new Error(`bundle evaluation failed: ${err.message}`)
  }

  if (!registration) throw new Error('bundle did not call window.__ModuleLoader__.load()')
  if (registration.id !== 'dsh-context-milvus') {
    throw new Error(`bundle registered id "${registration.id}", expected "dsh-context-milvus"`)
  }

  // 2. Materialize the factory exactly like ClientModuleSystem.materialize does.
  const exports = registration.factory((spec) => {
    if (!(spec in seeds)) {
      throw new Error(`require("${spec}") — not a seed word`)
    }
    return seeds[spec]
  })

  // 3. The loader calls the module's apply(ctx); ctx is only defined here.
  if (typeof exports.apply !== 'function') {
    throw new Error('bundle must export apply(ctx); got: ' + Object.keys(exports).join(', ') || '(no exports)')
  }

  // 4. The fiber needs the declared service names to make ctx.<service> reachable.
  //    Missing exports.inject → "cannot get property \"slots\" without inject".
  if (!Array.isArray(exports.inject) || exports.inject.length === 0) {
    throw new Error('bundle must export a non-empty inject array of service names')
  }
  for (const svc of exports.inject) {
    if (typeof svc !== 'string' || !svc.length) {
      throw new Error(`bundle inject must be service names, got: ${JSON.stringify(exports.inject)}`)
    }
  }
  if (!exports.inject.includes('slots')) {
    throw new Error(`bundle inject must include "slots" so ctx.slots is reachable; got: ${exports.inject.join(', ')}`)
  }

  console.log(`✓ client bundle materializes; exports apply(ctx) + inject [${exports.inject.join(', ')}]`)
} catch (err) {
  console.error(`✗ client bundle broken: ${err.message}`)
  process.exitCode = 1
} finally {
  if (prevWindow === undefined) delete globalThis.window
  else globalThis.window = prevWindow
}