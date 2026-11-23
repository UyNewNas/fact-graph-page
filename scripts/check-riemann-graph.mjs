import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { flowData } from '../src/graph-data.js'

const root = new URL('../public/', import.meta.url)
const read = async path => {
  const bytes = await readFile(new URL(path, root))
  return (path.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8')
}
const raw = JSON.parse(await read('riemann-graph.json'))
const graph = flowData(raw)
const commit = '7cbf7a0c32fca1badf05931879a37c3f8a2b03b4'
const prefix = `https://github.com/CocoSgt/riemann-hypothesis-lean/blob/${commit}/`
assert.equal(raw.sourceCommit, commit)
assert.equal(graph.isProofGraph, true)
assert.equal(graph.facts.length, 42)
assert.equal(graph.edges.length, 38)
assert.equal(graph.stats.statusCounts.source, 42)
assert.equal(graph.stats.statusCounts.green, 0)
assert.equal(raw.nodes.filter(node => node.group === 'mainline').length, 34)
assert.equal(raw.nodes.filter(node => node.group === 'audit').length, 8)
assert.equal(raw.localAudit.leanBuildRun, false)
assert.ok(raw.verificationReports.every(report => report.localRun === false && report.archiveSha256 === raw.provenance.archiveReportedSha256))
const byId = new Map(raw.nodes.map(node => [node.id, node]))
for (const id of raw.targets) assert.ok(byId.has(id), `target exists: ${id}`)
for (const chapter of raw.chapters) assert.ok(byId.has(chapter.node), `chapter exists: ${chapter.title}`)
for (const node of raw.nodes) {
  assert.ok(node.statement && node.proofExplanation && node.declarationName && node.module)
  assert.ok(node.evidence.length)
  for (const evidence of node.evidence) {
    assert.ok(evidence.url.startsWith(prefix + evidence.path + '#L'), `pinned evidence: ${node.id}`)
    assert.ok(Number.isInteger(evidence.startLine) && evidence.startLine > 0 && evidence.endLine >= evidence.startLine)
    assert.match(evidence.sha256, /^[a-f0-9]{64}$/)
    if (process.env.RIEMANN_SOURCE_ROOT) {
      const text = await readFile(join(process.env.RIEMANN_SOURCE_ROOT, evidence.path), 'utf8')
      assert.equal(createHash('sha256').update(text).digest('hex'), evidence.sha256, `source hash: ${node.id}`)
      const lines = text.split('\n').slice(evidence.startLine - 1, evidence.endLine).join('\n')
      assert.ok(lines.includes(node.declarationName.split('.').at(-1)), `declaration range: ${node.id}`)
    }
  }
}
for (const edge of raw.edges) {
  assert.ok(['proof-reference', 'statement-reference'].includes(edge.kind))
  assert.ok(edge.evidence.length && edge.dependencySemantics)
  for (const evidence of edge.evidence) {
    assert.ok(evidence.url.startsWith(prefix + evidence.path + '#L'))
    if (process.env.RIEMANN_SOURCE_ROOT) {
      const text = await readFile(join(process.env.RIEMANN_SOURCE_ROOT, evidence.path), 'utf8')
      const lines = text.split('\n').slice(evidence.startLine - 1, evidence.endLine).join('\n')
      assert.ok(lines.includes(byId.get(edge.from).declarationName.split('.').at(-1)), `reference range: ${edge.from} → ${edge.to}`)
    }
  }
}

const manifest = JSON.parse(await read('riemann-modules/manifest.json'))
for (const [path, expected] of Object.entries(manifest.files)) {
  const bytes = await readFile(new URL('riemann-modules/' + path, root))
  assert.equal(bytes.length, expected.bytes, `artifact size: ${path}`)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256, `artifact hash: ${path}`)
  if (path.endsWith('.gz')) assert.equal(createHash('sha256').update(gunzipSync(bytes)).digest('hex'), expected.uncompressedSha256, `JSON hash: ${path}`)
}
const names = JSON.parse(await read('riemann-modules/' + manifest.namesFile))
assert.equal(manifest.sourceCommit, commit)
assert.equal(manifest.schema, 'lean-module-index-v1')
assert.equal(names.length, 175187)
assert.equal(manifest.moduleCount, names.length)
assert.equal(raw.moduleCount, names.length)
assert.equal(new Set(names).size, names.length)
const ids = new Map(names.map((name, id) => [name, id]))
assert.ok(raw.nodes.every(node => ids.has(node.module)), 'Every curated source module exists in the full index')
const entries = []
for (let i = 0; i < Math.ceil(names.length / manifest.chunkSize); i++) {
  const chunk = JSON.parse(await read('riemann-modules/' + manifest.chunkPattern.replace('{chunk}', i)))
  assert.equal(chunk.length, Math.min(manifest.chunkSize, names.length - i * manifest.chunkSize))
  entries.push(...chunk)
}
let internalEdges = 0, externalEdges = 0, totalLines = 0
const incoming = names.map(() => [])
entries.forEach((entry, id) => {
  assert.ok(Number.isInteger(entry.lines) && entry.lines > 0)
  assert.match(entry.sha256, /^[a-f0-9]{64}$/)
  totalLines += entry.lines
  assert.equal(new Set(entry.imports.map(([target]) => target)).size, entry.imports.length)
  for (const [target, line] of entry.imports) {
    assert.ok(Number.isInteger(target) && target >= 0 && target < names.length && target !== id)
    assert.ok(Number.isInteger(line) && line >= 1 && line <= entry.lines)
    incoming[target].push(id)
    internalEdges++
  }
  for (const [name, line] of entry.externalImports) {
    assert.ok(typeof name === 'string' && name && !ids.has(name))
    assert.ok(Number.isInteger(line) && line >= 1 && line <= entry.lines)
    externalEdges++
  }
})
entries.forEach((entry, id) => assert.deepEqual(entry.importedBy, incoming[id], `reverse import list: ${names[id]}`))
assert.equal(internalEdges, manifest.internalEdgeCount)
assert.equal(externalEdges, manifest.externalEdgeCount)
assert.equal(totalLines, manifest.totalLines)
// Detect a cycle independently of the generator and prove complete Main import coverage.
const indegree = entries.map(entry => entry.imports.length)
const queue = indegree.flatMap((degree, id) => degree === 0 ? [id] : [])
for (let cursor = 0; cursor < queue.length; cursor++) for (const target of incoming[queue[cursor]]) if (--indegree[target] === 0) queue.push(target)
assert.equal(queue.length, names.length, 'Full import graph is acyclic')
const visited = new Set([ids.get('Main')]), stack = [...visited]
while (stack.length) for (const [target] of entries[stack.pop()].imports) if (!visited.has(target)) { visited.add(target); stack.push(target) }
assert.equal(visited.size, names.length, 'Main imports the entire indexed project, transitively')
console.log(`Riemann graph: ${graph.facts.length} curated nodes / ${graph.edges.length} source-supported edges; fixed commit evidence validated.`)
console.log(`Module index: ${names.length} modules / ${internalEdges} internal imports / ${externalEdges} external imports / ${totalLines} lines; all reciprocal lists, DAG and Main coverage validated.`)
if (process.env.RIEMANN_SOURCE_ROOT) console.log('All curated declarations, reference ranges and source hashes matched the local pinned checkout.')
