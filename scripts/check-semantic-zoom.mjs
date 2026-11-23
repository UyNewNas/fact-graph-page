import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { flowData } from '../src/graph-data.js'
import {
  NODE_WIDTH, NODE_HEIGHT, TIER_ZOOMS,
  resolveSemanticTier, buildSemanticGraph, collapsedSelection,
  selectViewportAnchor, preserveViewportAnchor,
} from '../src/semantic-zoom.js'

const base = flowData({
  schema: 'proof-dependencies-v1', project: 'Semantic zoom fixture',
  sourceRepository: 'fixture/source', sourceCommit: 'fixture-commit',
  nodes: [
    { id: 'a', declarationName: 'Lib.a', label: 'Owner A', status: 'source' },
    { id: 'b', declarationName: 'Lib.b', label: 'Owner B', status: 'source' },
    { id: 'c', declarationName: 'Lib.c', label: 'Owner C', status: 'source' },
  ],
  edges: [{ from: 'a', to: 'c', kind: 'proof-reference', reason: 'Original curated relation' }],
})
const evidence = [{ path: 'Lib.lean', startLine: 5, endLine: 5, url: 'https://example.test/pinned/Lib.lean#L5' }]
const referenceNode = (name, ownerId, revealTier, overviewIds = [ownerId]) => ({
  id: `decl:${name}`, declarationName: name, module: 'Lib', label: name,
  description: 'A located source declaration', status: 'source', kind: 'theorem',
  ownerId, overviewIds, revealTier, evidence,
})
const reference = (from, to, revealTier) => ({
  from, to, revealTier, kind: 'source-reference', reason: `${to} mentions ${from}`,
  dependencySemantics: 'resolved source reference; not kernel proof-term closure', evidence,
})
const expansion = {
  schema: 'riemann-source-expansion-v1', sourceCommit: 'fixture-commit', sourceRepository: 'fixture/source',
  nodes: [
    referenceNode('Lib.directA', 'a', 1),
    referenceNode('Lib.shared', 'a', 1, ['a', 'b']),
    referenceNode('Lib.directB', 'b', 1),
    referenceNode('Lib.deep', 'a', 2),
    referenceNode('Lib.cyclic', 'b', 2),
  ],
  edges: [
    reference('decl:Lib.directA', 'a', 1),
    reference('decl:Lib.shared', 'a', 1),
    reference('decl:Lib.shared', 'b', 1),
    reference('decl:Lib.directB', 'b', 1),
    reference('a', 'decl:Lib.directA', 1), // Source references need not form a DAG.
    reference('decl:Lib.deep', 'decl:Lib.directA', 2),
    reference('decl:Lib.cyclic', 'decl:Lib.directB', 2),
    reference('decl:Lib.directB', 'decl:Lib.cyclic', 2),
    reference('decl:Lib.deep', 'decl:Lib.shared', 2),
  ],
  coverage: { unresolvedReferences: 3 },
}
const ids = graph => graph.nodes.map(node => node.id).sort()
const byId = graph => new Map(graph.nodes.map(node => [node.id, node]))

test('hysteresis prevents boundary jitter and supports direct jumps in both directions', () => {
  const cases = [
    [0.499, 0, 0], [0.50, 0, 1], [1.049, 0, 1], [1.05, 0, 2], [1.7, 0, 2],
    [0.359, 1, 0], [0.36, 1, 1], [0.49, 1, 1], [1.049, 1, 1], [1.05, 1, 2],
    [0.20, 2, 0], [0.359, 2, 0], [0.36, 2, 1], [0.819, 2, 1], [0.82, 2, 2], [1.049, 2, 2],
  ]
  for (const [zoom, current, want] of cases) assert.equal(resolveSemanticTier(zoom, current), want, `zoom ${zoom}, tier ${current}`)
  let tier = 0
  const observed = [0.49, 0.501, 0.498, 0.502, 0.37, 0.359, 0.365, 0.499, 1.2, 1.04, 0.821, 0.819, 0.825, 0.35]
    .map(zoom => tier = resolveSemanticTier(zoom, tier))
  assert.deepEqual(observed, [0, 1, 1, 1, 1, 0, 0, 0, 2, 2, 2, 1, 1, 0])
  for (let target = 0; target < 3; target++) for (let current = 0; current < 3; current++) {
    assert.equal(resolveSemanticTier(TIER_ZOOMS[target], current), target, 'tier control zoom settles at its requested tier')
  }
})

test('overview returns the original graph immediately without expansion data', () => {
  assert.equal(buildSemanticGraph(base, null, 0), base)
  assert.equal(buildSemanticGraph(base, expansion, 0), base)
})

test('tiers add stable declaration identities, preserve every original edge, and expose current inspector relations', () => {
  const medium = buildSemanticGraph(base, expansion, 1)
  const fine = buildSemanticGraph(base, expansion, 2)
  assert.ok(medium && fine, 'both expanded tier graphs exist')
  assert.deepEqual(ids(medium), ['a', 'b', 'c', 'decl:Lib.directA', 'decl:Lib.directB', 'decl:Lib.shared'])
  assert.deepEqual(ids(fine), ['a', 'b', 'c', 'decl:Lib.cyclic', 'decl:Lib.deep', 'decl:Lib.directA', 'decl:Lib.directB', 'decl:Lib.shared'])
  assert.equal(medium.edges.length, 6)
  assert.equal(fine.edges.length, 10)
  for (const graph of [medium, fine]) {
    const known = new Set(ids(graph))
    assert.equal(new Set(graph.edges.map(edge => edge.id)).size, graph.edges.length)
    assert.ok(base.edges.every(edge => graph.edges.includes(edge)), 'curated edge records are retained')
    for (const edge of graph.edges) assert.ok(known.has(edge.source) && known.has(edge.target), `no dangling endpoint: ${edge.id}`)
    assert.equal(graph.stats.total, known.size)
    assert.equal(graph.stats.edges, graph.edges.length)
    assert.equal(graph.stats.statusCounts.source, known.size)
    assert.equal(graph.stats.dangling, 0)
  }
  assert.ok(medium.edges.every(edge => fine.edges.some(candidate => candidate.id === edge.id)), 'edge identities are nested')
  assert.deepEqual(fine.facts.find(node => node.id === 'decl:Lib.directA').predecessors.sort(), ['a', 'decl:Lib.deep'])
  assert.deepEqual(fine.facts.find(node => node.id === 'decl:Lib.shared').children.sort(), ['a', 'b'])
  assert.deepEqual(fine.factDetails['decl:Lib.directA'].incoming.map(edge => edge.from).sort(), ['a', 'decl:Lib.deep'])
  assert.deepEqual(fine.factDetails['decl:Lib.shared'].outgoing.map(edge => edge.to).sort(), ['a', 'b'])
  assert.deepEqual(fine.factDetails['decl:Lib.deep'].evidence, evidence)
  assert.equal(fine.factDetails['decl:Lib.deep'].statement, undefined, 'a full theorem statement is never invented')
  assert.equal(fine.facts.find(node => node.id === 'decl:Lib.deep').isExpansionBoundary, true)
  assert.equal(fine.facts.find(node => node.id === 'decl:Lib.directA').isExpansionBoundary, false)
  assert.deepEqual(fine.source.expansion.coverage, { unresolvedReferences: 3 })
})

test('shared references, cyclic relations, and separately evidenced parallel relations are never silently discarded', () => {
  const extra = structuredClone(expansion)
  extra.edges.push({ ...reference('decl:Lib.shared', 'a', 1), reason: 'A second source occurrence', evidence: [{ ...evidence[0], startLine: 9, endLine: 9 }] })
  const fine = buildSemanticGraph(base, extra, 2)
  assert.ok(fine)
  assert.equal(fine.edges.length, 11)
  const relations = fine.edges.map(edge => `${edge.source}>${edge.target}`)
  for (const relation of ['a>decl:Lib.directA', 'decl:Lib.directA>a', 'decl:Lib.cyclic>decl:Lib.directB', 'decl:Lib.directB>decl:Lib.cyclic', 'decl:Lib.shared>b']) {
    assert.ok(relations.includes(relation), `retained source relation: ${relation}`)
  }
  assert.equal(relations.filter(relation => relation === 'decl:Lib.shared>a').length, 2)
  assert.equal(new Set(fine.edges.map(edge => edge.id)).size, 11)
})

test('a partially resolved middle declaration remains an expansion boundary after deeper references appear', () => {
  const partial = structuredClone(expansion)
  partial.nodes.find(node => node.id === 'decl:Lib.directA').boundary = {
    isBoundary: true, reason: 'static-resolution-limit', referencesExpanded: true, unexpandedReferenceCount: 2,
  }
  const fine = buildSemanticGraph(base, partial, 2)
  const declaration = fine.facts.find(node => node.id === 'decl:Lib.directA')
  assert.deepEqual(declaration.predecessors.sort(), ['a', 'decl:Lib.deep'], 'known dependencies remain visible')
  assert.equal(declaration.isExpansionBoundary, true, 'visible references do not imply complete source resolution')
  assert.equal(fine.factDetails['decl:Lib.directA'].isExpansionBoundary, true)
  assert.equal(fine.factDetails['decl:Lib.directA'].boundary.unexpandedReferenceCount, 2)
})

test('tier collapse keeps a visible selection and otherwise returns its overview owner', () => {
  assert.equal(collapsedSelection('decl:Lib.deep', base, expansion, 2), 'decl:Lib.deep')
  assert.equal(collapsedSelection('decl:Lib.deep', base, expansion, 1), 'a')
  assert.equal(collapsedSelection('decl:Lib.shared', base, expansion, 0), 'a')
  assert.equal(collapsedSelection('decl:Lib.directB', base, expansion, 0), 'b')
  assert.equal(collapsedSelection('c', base, null, 0), 'c')
  assert.equal(collapsedSelection('unknown', base, expansion, 1), null)
  assert.equal(collapsedSelection(null, base, expansion, 2), null)
})

test('deterministic local layout gives every visible card space and keeps direct references near their owner', () => {
  const dense = structuredClone(expansion)
  for (let index = 0; index < 180; index++) {
    const owner = ['a', 'b', 'c'][index % 3]
    const tier = index % 4 === 0 ? 1 : 2
    const name = `Fixture.ref${index}`
    dense.nodes.push(referenceNode(name, owner, tier))
    dense.edges.push(reference(`decl:${name}`, owner, tier))
  }
  const before = JSON.stringify({ base, dense })
  const medium = buildSemanticGraph(base, dense, 1)
  const fine = buildSemanticGraph(base, dense, 2)
  assert.ok(medium && fine)
  assert.equal(JSON.stringify({ base, dense }), before, 'input snapshots remain unchanged')
  assert.deepEqual(fine.nodes, buildSemanticGraph(base, dense, 2).nodes, 'repeatable layout')
  for (const graph of [medium, fine]) {
    for (const node of graph.nodes) {
      assert.equal(node.width, NODE_WIDTH)
      assert.equal(node.height, NODE_HEIGHT)
      assert.ok(Number.isFinite(node.position.x) && Number.isFinite(node.position.y))
    }
    for (let i = 0; i < graph.nodes.length; i++) for (let j = i + 1; j < graph.nodes.length; j++) {
      const a = graph.nodes[i], b = graph.nodes[j]
      const overlap = a.position.x < b.position.x + b.width && a.position.x + a.width > b.position.x &&
        a.position.y < b.position.y + b.height && a.position.y + a.height > b.position.y
      assert.equal(overlap, false, `visible cards do not overlap: ${a.id} and ${b.id}`)
    }
    const mapped = byId(graph)
    for (const owner of ['a', 'b', 'c']) {
      const position = mapped.get(owner).position
      const nearestDirect = graph.nodes.filter(node => node.data.ownerId === owner && node.data.revealTier === 1)
        .reduce((nearest, node) => Math.min(nearest, Math.hypot(node.position.x - position.x, node.position.y - position.y)), Infinity)
      assert.ok(nearestDirect <= 350, `a meaningful direct reference stays near owner ${owner}`)
    }
  }
  const mediumById = byId(medium), fineById = byId(fine)
  for (const node of medium.nodes.filter(node => node.data.isExpansion)) {
    const oldOwner = mediumById.get(node.data.ownerId), newOwner = fineById.get(node.data.ownerId)
    const later = fineById.get(node.id)
    assert.deepEqual(
      { x: node.position.x - oldOwner.position.x, y: node.position.y - oldOwner.position.y },
      { x: later.position.x - newOwner.position.x, y: later.position.y - newOwner.position.y },
      `common reference retains its local offset when the cluster unfolds: ${node.id}`,
    )
  }
})

test('invalid versions, duplicate identities, unknown ownership, and inconsistent edge tiers fail visibly', () => {
  const invalid = mutate => { const value = structuredClone(expansion); mutate(value); return value }
  assert.throws(() => buildSemanticGraph(base, invalid(value => value.schema = 'different-schema'), 1), /schema|格式/i)
  assert.throws(() => buildSemanticGraph(base, invalid(value => value.sourceCommit = 'different-commit'), 1), /commit|版本/i)
  assert.throws(() => buildSemanticGraph(base, invalid(value => value.nodes.push({ ...value.nodes[0], label: 'conflicting identity' })), 2), /duplicate|重复/i)
  assert.throws(() => buildSemanticGraph(base, invalid(value => value.nodes[0].id = 'a'), 1), /duplicate|重复/i)
  assert.throws(() => buildSemanticGraph(base, invalid(value => value.nodes[0].ownerId = 'missing'), 2), /owner|归属/i)
  assert.throws(() => buildSemanticGraph(base, invalid(value => value.edges[0].from = 'missing'), 1), /endpoint|端点/i)
  assert.throws(() => buildSemanticGraph(base, invalid(value => value.edges[5].revealTier = 1), 1), /tier|粒度/i)
  assert.throws(() => buildSemanticGraph(base, invalid(value => value.nodes[0].revealTier = 0), 1), /tier|粒度/i)
})

const anchorOld = { nodes: [
  { id: 'a', position: { x: 0, y: 0 }, width: 242, height: 150 },
  { id: 'b', position: { x: 350, y: 0 }, width: 242, height: 150 },
  { id: 'outside', position: { x: 900, y: 900 }, width: 242, height: 150 },
  { id: 'disappearing', position: { x: 350, y: 0 }, width: 242, height: 150 },
] }
const anchorNew = { nodes: [
  { id: 'a', position: { x: 50, y: 400 }, width: 242, height: 150 },
  { id: 'b', position: { x: 900, y: -40 }, width: 242, height: 150 },
  { id: 'outside', position: { x: 1800, y: 900 }, width: 242, height: 150 },
] }
const viewport = { x: 40, y: -20, zoom: 2 }
const canvasSize = { width: 800, height: 500 }

test('anchor choice follows off-center pointer, ignores collapsed IDs, and prefers selection only while visible', () => {
  assert.equal(selectViewportAnchor(anchorOld, anchorNew, viewport, canvasSize, null, { x: 740, y: 130 }), 'b')
  assert.equal(selectViewportAnchor(anchorOld, anchorNew, viewport, canvasSize), 'a')
  assert.equal(selectViewportAnchor(anchorOld, anchorNew, viewport, canvasSize, 'outside', { x: 740, y: 130 }), 'b')
  assert.equal(selectViewportAnchor(anchorOld, anchorNew, viewport, canvasSize, 'disappearing', { x: 740, y: 130 }), 'b')
  assert.equal(selectViewportAnchor(anchorOld, anchorNew, viewport, canvasSize, 'b'), 'b')
  assert.equal(selectViewportAnchor({ nodes: [] }, anchorNew, viewport, canvasSize), null)
})

test('anchor compensation keeps the same declaration center at its screen position without undoing zoom', () => {
  const oldNode = anchorOld.nodes[1], newNode = anchorNew.nodes[1]
  const next = preserveViewportAnchor(oldNode, newNode, viewport)
  assert.deepEqual(next, { x: -1060, y: 60, zoom: 2 })
  assert.deepEqual(viewport, { x: 40, y: -20, zoom: 2 }, 'viewport is not mutated')
  const screen = (node, view) => ({ x: (node.position.x + node.width / 2) * view.zoom + view.x, y: (node.position.y + node.height / 2) * view.zoom + view.y })
  assert.deepEqual(screen(oldNode, viewport), { x: 982, y: 130 })
  assert.deepEqual(screen(newNode, next), { x: 982, y: 130 })
  const resized = preserveViewportAnchor(oldNode, { ...newNode, width: 300, height: 180 }, viewport)
  assert.deepEqual(resized, { x: -1118, y: 30, zoom: 2 }, 'compensation uses centers rather than top-left corners')
  assert.throws(() => preserveViewportAnchor(oldNode, { ...newNode, id: 'unrelated' }, viewport), /same|相同|identity/i)
})

const actualExpansion = await readFile(new URL('../public/riemann-expansion.json', import.meta.url), 'utf8')
  .then(JSON.parse)
  .catch(error => { if (error.code === 'ENOENT') return null; throw error })

test('pinned RH expansion produces three nested graphs with every source relation and fixed card geometry', { skip: !actualExpansion }, async () => {
  const raw = JSON.parse(await readFile(new URL('../public/riemann-graph.json', import.meta.url), 'utf8'))
  const commit = '7cbf7a0c32fca1badf05931879a37c3f8a2b03b4'
  assert.equal(raw.sourceCommit, commit)
  assert.equal(actualExpansion.sourceCommit, commit)
  const overview = flowData(raw)
  const graphs = [0, 1, 2].map(tier => buildSemanticGraph(overview, actualExpansion, tier))
  assert.equal(graphs[0], overview)
  assert.equal(graphs[0].nodes.length, 42)
  assert.equal(graphs[0].edges.length, 38)
  for (const tier of [1, 2]) {
    const graph = graphs[tier]
    const known = new Set(ids(graph))
    assert.ok(graph.nodes.length > graphs[tier - 1].nodes.length, `tier ${tier} reveals new declarations`)
    assert.ok(graphs[tier - 1].nodes.every(node => known.has(node.id)), `tier ${tier} preserves previous declarations`)
    assert.equal(known.size, graph.nodes.length, 'shared declarations have one visual identity')
    assert.equal(graph.edges.length, 38 + actualExpansion.edges.filter(edge => edge.revealTier <= tier).length)
    for (const edge of graph.edges) assert.ok(known.has(edge.source) && known.has(edge.target), `actual endpoint integrity: ${edge.id}`)
    for (const node of graph.nodes) {
      assert.equal(node.width, 242)
      assert.equal(node.height, 150)
      assert.ok(Number.isFinite(node.position.x) && Number.isFinite(node.position.y))
    }
    const sorted = [...graph.nodes].sort((a, b) => a.position.x - b.position.x)
    for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length && sorted[j].position.x < sorted[i].position.x + 242; j++) {
      const a = sorted[i], b = sorted[j]
      assert.ok(a.position.y + 150 <= b.position.y || b.position.y + 150 <= a.position.y, `actual cards do not overlap: ${a.id}, ${b.id}`)
    }
  }
  console.log('Semantic RH tiers: ' + graphs.map((graph, tier) => `${tier}: ${graph.nodes.length} declarations / ${graph.edges.length} relations`).join('; '))
})
