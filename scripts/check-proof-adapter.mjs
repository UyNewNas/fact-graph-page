import assert from 'node:assert/strict'
import { flowData, statusInfo } from '../src/graph-data.js'

// Catch a new proof dataset being silently treated as a legacy (green) fact graph.
const raw = {
  schema: 'proof-dependencies-v1',
  project: 'RH / Dirichlet GRH',
  sourceRepository: 'CocoSgt/riemann-hypothesis-lean',
  sourceCommit: '7cbf7a0c32fca1badf05931879a37c3f8a2b03b4',
  nodeUnit: '个主线节点',
  snapshotAt: '2026-11-20', dashboardUrl: 'https://example.com/source', sourceFiles: { original: { sha256: 'fixture' } },
  verificationReports: [{ status: 'reported-pass', localRun: false }],
  nodes: [
    { id: 'every', label: '全部特征', status: 'source', module: 'A', declarationName: 'everyCharacter', statement: 'Re(s) > 1/2 ⇒ L(s, χ) ≠ 0', evidence: [{ url: 'https://example.com/a' }] },
    { id: 'rh', label: '黎曼猜想', status: 'source', module: 'Main', proofExplanation: '由已提供的全特征结论专门化。' },
  ],
  edges: [{ from: 'every', to: 'rh', kind: 'proof-reference', reason: '源码中的实际引用', evidence: [{ url: 'https://example.com/b' }] }],
}
const before = JSON.stringify(raw)
const graph = flowData(raw)
assert.equal(graph.isDependencyGraph, true)
assert.equal(graph.isProofGraph, true)
assert.equal(graph.project, 'RH / Dirichlet GRH')
assert.equal(graph.source.sourceRepository, 'CocoSgt/riemann-hypothesis-lean')
assert.equal(graph.source.snapshotAt, '2026-11-20')
assert.equal(graph.source.dashboardUrl, 'https://example.com/source')
assert.deepEqual(graph.source.sourceFiles, { original: { sha256: 'fixture' } })
assert.equal(graph.stats.statusCounts.source, 2)
assert.equal(graph.stats.statusCounts.green, 0)
assert.equal(statusInfo('source').key, 'source')
assert.deepEqual(graph.factDetails.every.statement, raw.nodes[0].statement)
assert.deepEqual(graph.factDetails.every.evidence, raw.nodes[0].evidence)
assert.deepEqual(graph.factDetails.rh.proofExplanation, raw.nodes[1].proofExplanation)
assert.deepEqual(graph.factDetails.rh.incoming, raw.edges)
assert.deepEqual(graph.source.verificationReports, [{ status: 'reported-pass', localRun: false }])
assert.equal(graph.facts.find(node => node.id === 'rh').level, 1)
assert.equal(JSON.stringify(raw), before)
assert.throws(() => flowData({ ...raw, schema: 'unsupported-v99' }), /格式|schema/)
assert.throws(() => flowData({ ...raw, edges: [{ from: 'absent', to: 'rh' }] }), /端点/)
assert.throws(() => flowData({ ...raw, edges: [...raw.edges, { from: 'rh', to: 'every' }] }), /循环/)
const unknown = flowData({ ...raw, nodes: raw.nodes.map(node => ({ ...node, status: 'not-a-verification' })) })
assert.equal(unknown.stats.statusCounts.unknown, 2)
assert.equal(unknown.stats.statusCounts.green, 0)
console.log('Proof adapter: provenance preserved; source status never promoted to verified; invalid schema, edges and cycles rejected.')
