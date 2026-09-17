/**
 * Jest-only repair for tree-sitter's `Tree.prototype.rootNode` getter.
 *
 * Root cause (verified against tree-sitter 0.25.1 `index.js`):
 *
 *     const {rootNode, rootNodeWithOffset, edit} = Tree.prototype;   // line 13
 *     Object.defineProperty(Tree.prototype, 'rootNode', {            // line 15
 *       get() {
 *         if (this instanceof Tree && rootNode) { ... }              // line 27
 *       },
 *       configurable: true,                                          // line 33
 *     });
 *
 * Jest hands every test *file* a fresh module registry, so `index.js` is
 * evaluated once per spec file — but the native `Tree.prototype` it patches
 * comes from the shared `.node` addon and is process-wide. The second
 * evaluation destructures `Tree.prototype` again, which now reads the JS getter
 * installed by the first evaluation with `this === Tree.prototype`. That fails
 * the getter's own `this instanceof Tree` guard, so it captures `undefined` and
 * then re-installs a getter that returns `undefined` forever. `rootNodeWithOffset`
 * is clobbered the same way.
 *
 * From that point on `tree.rootNode` is undefined, so `chunkCode` throws, falls
 * back to a regex pass that finds nothing in TypeScript, and silently reports
 * zero chunks. The corruption is scheduling-dependent: any Jest worker running
 * two or more specs that (transitively) import the chunker breaks the second
 * one. It reproduces deterministically under `--runInBand`.
 *
 * Fix: tree-sitter marks the property `configurable: true` specifically so it
 * can be overridden, so remember the first (working) getter and put it back
 * whenever a later evaluation clobbers it. The saved getter keeps working after
 * the clobber because it closes over the *original* native method.
 *
 * The saved getter is stashed on the native prototype itself, NOT on
 * `globalThis` or `process`: Jest gives every test file its own vm context, so
 * both of those are per-file (verified — a marker set in one spec reads back as
 * `undefined` in the next). `Tree.prototype` is the one object that is genuinely
 * shared across test files, which is exactly why it is the thing that breaks.
 *
 * Wired up through `moduleNameMapper` in jest.config.js. The real module is
 * required by absolute path so that mapping `^tree-sitter$` to this file cannot
 * recurse.
 */
const path = require('node:path')

const realTreeSitterDir = path.dirname(require.resolve('tree-sitter/package.json'))
const Parser = require(realTreeSitterDir)

const SAVED_GETTER = '__dshWorkingRootNodeGetter'

const TreeProto = Parser && Parser.Tree && Parser.Tree.prototype
if (TreeProto) {
  const desc = Object.getOwnPropertyDescriptor(TreeProto, 'rootNode')
  if (desc && typeof desc.get === 'function') {
    const saved = TreeProto[SAVED_GETTER]
    if (!saved) {
      // First evaluation in this process — this getter still works. Keep it.
      Object.defineProperty(TreeProto, SAVED_GETTER, {
        value: desc.get,
        configurable: true,
        writable: true,
        enumerable: false,
      })
    } else if (desc.get !== saved) {
      // A later evaluation re-installed a getter that captured `undefined`.
      // Restore the working one.
      Object.defineProperty(TreeProto, 'rootNode', { ...desc, get: saved })
    }
  }
}

module.exports = Parser
