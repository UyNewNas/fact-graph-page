import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { flowData, statusInfo, edgeKindLabel } from '../src/graph-data.js'

const read = name => readFile(new URL(`../public/${name}`, import.meta.url), 'utf8')
const rawText = await read('goldbach-graph.json')
const raw = JSON.parse(rawText)
const supplement = JSON.parse(await read('goldbach-details.json'))
const before = JSON.stringify({ raw, supplement })
const graph = flowData(raw, supplement)

// The imported data must be the complete dashboard snapshot, not its core view.
const snapshotSha256 = 'e2bbf3071b6eb1d97fad3782aa80dd124d9f6cc9de8baa443fc93d96097e2df4'
assert.equal(createHash('sha256').update(rawText).digest('hex'), snapshotSha256)
assert.equal(supplement.sourceFiles['dependencies.json'].sha256, snapshotSha256)
assert.equal(supplement.sourceCommit, raw.sourceCommit)
assert.equal(raw.nodes.length, 86)
assert.equal(raw.edges.length, 108)
assert.equal(graph.nodes.length, 86)
assert.equal(graph.facts.length, 86)
assert.equal(graph.edges.length, 108)
assert.equal(graph.isDependencyGraph, true)
assert.deepEqual(graph.stats.statusCounts, { green: 35, yellow: 30, red: 21, revoked: 0, unknown: 0 })
assert.equal(graph.source.sourceCommit, '24217fc9b7c385689c992c4ea8c2d1f6026db3db')
assert.deepEqual(graph.source.targets, raw.targets)
assert.deepEqual(graph.source.frontier, raw.frontier)
assert.equal(graph.source.reviewedAt, raw.reviewedAt)

const nodes = new Map(graph.facts.map(node => [node.id, node]))
assert.equal(nodes.size, 86)
assert.equal(new Set(graph.edges.map(edge => edge.id)).size, 108)
for (const original of raw.nodes) {
  const node = nodes.get(original.id)
  const detail = graph.factDetails[original.id]
  // Every original field, including evidence/admission metadata, survives export.
  for (const [key, value] of Object.entries(original)) {
    assert.deepEqual(node[key], value, `normalized node ${original.id}.${key}`)
    assert.deepEqual(detail[key], value, `detail ${original.id}.${key}`)
  }
  assert.equal(node.status, original.status)
  assert.equal('proof' in detail, false, 'A task description is not a fabricated proof')
  assert.deepEqual(detail.incoming, raw.edges.filter(edge => edge.to === original.id))
  assert.deepEqual(detail.outgoing, raw.edges.filter(edge => edge.from === original.id))
  assert.deepEqual(node.predecessors, [...new Set(detail.incoming.map(edge => edge.from))])
  assert.deepEqual(node.children, [...new Set(detail.outgoing.map(edge => edge.to))])
  const extra = supplement.nodes[original.id]
  if (extra?.criteria) assert.deepEqual(detail.criteria, extra.criteria)
  if (extra?.links) assert.deepEqual(detail.links, extra.links)
}
graph.edges.forEach((edge, index) => {
  const original = raw.edges[index]
  assert.deepEqual(edge.data, original)
  assert.equal(edge.source, original.from)
  assert.equal(edge.target, original.to)
  assert.equal(edge.className, `edge-${original.kind}`)
  assert.ok(nodes.has(edge.source) && nodes.has(edge.target), 'All edge endpoints exist')
  assert.ok(nodes.get(edge.source).level < nodes.get(edge.target).level, 'Topological layers preserve every edge')
})
const alternative = graph.edges.filter(edge => edge.data.kind === 'alternative')
assert.equal(alternative.length, 1)
assert.equal(alternative[0].source, 'elementary-shifted-moment')
assert.equal(alternative[0].target, 'common-p-shifted-moment')
assert.equal(edgeKindLabel('alternative'), '替代路线')
const transitive = graph.edges.filter(edge => edge.data.dependencySemantics === 'transitive-project-closure-prerequisite')
assert.equal(transitive.length, 3)
assert.ok(transitive.every(edge => edge.data.directImport === false))
assert.equal(Object.keys(supplement.nodes).length, 73)
assert.ok(Object.keys(supplement.nodes).every(id => nodes.has(id)))
assert.equal(Object.values(supplement.nodes).filter(node => node.criteria?.length).length, 42)
assert.equal(Object.values(supplement.nodes).filter(node => node.links?.length).length, 41)
assert.equal(JSON.stringify({ raw, supplement }), before, 'Adapters leave raw snapshots unchanged')

// Regression check against the actual retained Danus snapshot.
const legacyRaw = JSON.parse(await read('fact-graph.json'))
const legacy = flowData(legacyRaw)
assert.equal(legacy.isDependencyGraph, false)
assert.equal(legacy.facts.length, 734)
assert.equal(legacy.edges.length, 2398)
assert.deepEqual(legacy.stats.statusCounts, { green: 729, yellow: 0, red: 0, revoked: 5, unknown: 0 })
assert.equal(legacy.project, legacyRaw.problem_id)
assert.deepEqual(legacy.factDetails, legacyRaw.facts)
for (const original of legacyRaw.nodes) {
  const node = legacy.facts.find(item => item.id === original.id)
  assert.equal(node.status, original.revoked ? 'revoked' : 'green')
  assert.deepEqual(node.predecessors, original.predecessors)
  assert.deepEqual(node.children, original.children)
}

// Multiple relation kinds between the same nodes must remain separate edges.
const parallelRaw = {
  schema: raw.schema,
  nodes: [{ id: 'a', label: 'A', status: 'green' }, { id: 'b', label: 'B', status: 'yellow' }],
  edges: [
    { from: 'a', to: 'b', kind: 'source', reason: 'required', evidence: [] },
    { from: 'a', to: 'b', kind: 'alternative', reason: 'alternative', evidence: [] },
  ],
}
const parallel = flowData(parallelRaw)
assert.equal(new Set(parallel.edges.map(edge => edge.id)).size, 2)
assert.deepEqual(parallel.edges.map(edge => edge.data), parallelRaw.edges)
assert.deepEqual(parallel.facts.find(node => node.id === 'b').predecessors, ['a'])
assert.equal(statusInfo({}).key, 'unknown')
assert.equal(statusInfo('yellow').key, 'yellow')
assert.throws(() => flowData({ ...parallelRaw, edges: [{ from: 'missing', to: 'b' }] }), /端点/)
assert.throws(() => flowData({ ...parallelRaw, edges: [...parallelRaw.edges, { from: 'b', to: 'a' }] }), /循环/)
assert.throws(() => flowData(raw, { sourceCommit: 'different' }), /版本不一致/)

console.log('Goldbach graph verified: 86 nodes / 108 edges; statuses 35 green / 30 yellow / 21 red; 73 detail supplements.')
console.log('All original metadata and relation kinds preserved; legacy regression passed: 734 nodes / 2398 edges.')
