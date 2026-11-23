import assert from 'node:assert/strict'
import { normalizeModuleQuery, sourceModulePath, sourceModuleUrl } from '../src/module-paths.js'
const manifest = { sourceRepository: 'CocoSgt/riemann-hypothesis-lean', sourceCommit: '7cbf7a0c32fca1badf05931879a37c3f8a2b03b4', sourceDirectory: 'src' }
assert.equal(sourceModuleUrl(manifest, 'Main'), 'https://github.com/CocoSgt/riemann-hypothesis-lean/blob/7cbf7a0c32fca1badf05931879a37c3f8a2b03b4/src/Main.lean')
assert.equal(sourceModuleUrl(manifest, 'Main') + '#L2', 'https://github.com/CocoSgt/riemann-hypothesis-lean/blob/7cbf7a0c32fca1badf05931879a37c3f8a2b03b4/src/Main.lean#L2')
assert.equal(sourceModulePath(manifest, 'Formalism.GaloisGeometry₂'), 'src/Formalism/GaloisGeometry₂.lean')
assert.ok(sourceModuleUrl(manifest, 'Formalism.GaloisGeometry₂').endsWith('/src/Formalism/GaloisGeometry%E2%82%82.lean'))
for (const input of ['Main', ' main.lean ', 'src/Main.lean', './src/Main.lean', 'src\\Main.lean']) assert.equal(normalizeModuleQuery(input), 'main')
assert.equal(normalizeModuleQuery('src/Formalism/GaloisGeometry₂.lean'), 'formalism.galoisgeometry₂')
assert.equal(normalizeModuleQuery('srcish.SomeModule'), 'srcish.somemodule')
assert.equal(normalizeModuleQuery('   '), '')
console.log('Module paths: fixed src/ links, import anchors, Unicode paths and source-file searches passed.')
