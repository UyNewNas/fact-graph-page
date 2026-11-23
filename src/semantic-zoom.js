// A source-reference expansion is not a kernel proof dependency DAG. Keep its
// complete relation set and use the overview's layers only to organize space.
export const NODE_WIDTH = 242
export const NODE_HEIGHT = 150
export const TIER_ZOOMS = Object.freeze([0.24, 0.72, 1.30])
export const TIER_LABELS = Object.freeze(['概览', '直接引用', '下一层引用'])

const CELL_WIDTH = NODE_WIDTH + 44
const CELL_HEIGHT = NODE_HEIGHT + 44
const CLUSTER_GAP_X = 140
const CLUSTER_GAP_Y = 150
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim()
const compareIds = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0
const validTier = tier => Number.isInteger(tier) && tier >= 0 && tier <= 2

/** Hysteresis is evaluated through both boundaries, including large wheel jumps. */
export function resolveSemanticTier(zoom, currentTier = 0) {
  let tier = validTier(currentTier) ? currentTier : 0
  if (!Number.isFinite(zoom) || zoom <= 0) return tier
  while (tier < 2 && zoom >= [0.50, 1.05][tier]) tier++
  while (tier > 0 && zoom < [0.36, 0.82][tier - 1]) tier--
  return tier
}

function validateExpansion(baseGraph, expansion) {
  if (!Array.isArray(baseGraph?.nodes) || !Array.isArray(baseGraph?.edges) || !Array.isArray(baseGraph?.facts)) {
    throw new Error('Semantic zoom requires an adapted overview graph')
  }
  if (expansion?.schema !== 'riemann-source-expansion-v1' || !Array.isArray(expansion.nodes) || !Array.isArray(expansion.edges)) {
    throw new Error('Unsupported semantic expansion schema or missing nodes/edges')
  }
  if (baseGraph.source?.sourceCommit && expansion.sourceCommit !== baseGraph.source.sourceCommit) {
    throw new Error('Overview and expansion source commit versions differ')
  }
  const overviewIds = new Set(baseGraph.nodes.map(node => node.id))
  if (overviewIds.size !== baseGraph.nodes.length) throw new Error('Duplicate overview node identity')
  const tiers = new Map([...overviewIds].map(id => [id, 0]))
  for (const node of expansion.nodes) {
    if (tiers.has(node.id)) throw new Error(`Duplicate expansion node identity: ${node.id}`)
    if (typeof node.id !== 'string' || !node.id || typeof node.declarationName !== 'string' || !node.declarationName) {
      throw new Error('Expansion node is missing its declaration identity')
    }
    if (node.revealTier !== 1 && node.revealTier !== 2) throw new Error(`Invalid reveal tier: ${node.id}`)
    if (!overviewIds.has(node.ownerId)) throw new Error(`Unknown overview owner: ${node.id}`)
    if (!Array.isArray(node.overviewIds) || !node.overviewIds.includes(node.ownerId) || node.overviewIds.some(id => !overviewIds.has(id))) {
      throw new Error(`Invalid overview ownership: ${node.id}`)
    }
    tiers.set(node.id, node.revealTier)
  }
  for (const edge of baseGraph.edges) {
    if (!overviewIds.has(edge.source) || !overviewIds.has(edge.target)) throw new Error('Overview edge has an unknown endpoint')
  }
  for (const edge of expansion.edges) {
    if (!tiers.has(edge.from) || !tiers.has(edge.to)) throw new Error(`Expansion edge has an unknown endpoint: ${edge.from} → ${edge.to}`)
    if (edge.kind !== 'source-reference') throw new Error('Expansion edge must be a source-reference relation')
    if ((edge.revealTier !== 1 && edge.revealTier !== 2) || edge.revealTier < Math.max(tiers.get(edge.from), tiers.get(edge.to))) {
      throw new Error(`Expansion edge has an inconsistent reveal tier: ${edge.from} → ${edge.to}`)
    }
  }
}

// Fill the closest card-sized grid cells first. The same full owner list is
// used at every tier, so an existing declaration retains its local position.
function localPositions(count) {
  const radius = Math.ceil(Math.sqrt(count + 1)) + 1
  const cells = []
  for (let y = -radius; y <= radius; y++) for (let x = -radius; x <= radius; x++) {
    if (x || y) cells.push({ x: x * CELL_WIDTH, y: y * CELL_HEIGHT })
  }
  cells.sort((a, b) => a.x * a.x + a.y * a.y - b.x * b.x - b.y * b.y || a.y - b.y || a.x - b.x)
  return cells.slice(0, count)
}

function expandedPositions(baseGraph, allReferences, tier) {
  const members = new Map(baseGraph.nodes.map(node => [node.id, []]))
  for (const node of allReferences) members.get(node.ownerId).push(node)
  const rows = new Map()
  for (const owner of baseGraph.nodes) {
    const references = members.get(owner.id).sort((a, b) => a.revealTier - b.revealTier || compareIds(a, b))
    const cells = localPositions(references.length)
    const local = [{ id: owner.id, x: 0, y: 0 }]
    references.forEach((node, index) => {
      if (node.revealTier <= tier) local.push({ id: node.id, ...cells[index] })
    })
    const minX = Math.min(...local.map(node => node.x))
    const minY = Math.min(...local.map(node => node.y))
    const maxX = Math.max(...local.map(node => node.x)) + NODE_WIDTH
    const maxY = Math.max(...local.map(node => node.y)) + NODE_HEIGHT
    const row = owner.position.y
    if (!rows.has(row)) rows.set(row, [])
    rows.get(row).push({ owner, local, minX, minY, maxX, maxY, width: maxX - minX })
  }
  const positions = new Map()
  let rowY = Math.min(0, ...rows.keys())
  for (const row of [...rows.keys()].sort((a, b) => a - b)) {
    const groups = rows.get(row).sort((a, b) => a.owner.position.x - b.owner.position.x || compareIds(a.owner, b.owner))
    const rowWidth = groups.reduce((sum, group) => sum + group.width, 0) + CLUSTER_GAP_X * (groups.length - 1)
    const above = Math.max(...groups.map(group => -group.minY))
    const below = Math.max(...groups.map(group => group.maxY))
    let left = -rowWidth / 2
    for (const group of groups) {
      for (const node of group.local) positions.set(node.id, { x: left - group.minX + node.x, y: rowY + above + node.y })
      left += group.width + CLUSTER_GAP_X
    }
    rowY += above + below + CLUSTER_GAP_Y
  }
  return positions
}

/**
 * baseGraph is flowData(raw). Tier 0 returns it unchanged, including while the
 * optional expansion asset is loading. Tiers 1/2 retain all curated records.
 */
export function buildSemanticGraph(baseGraph, expansion, tier) {
  if (!validTier(tier)) throw new Error('Invalid semantic tier')
  if (tier === 0) return baseGraph
  validateExpansion(baseGraph, expansion)
  const additions = expansion.nodes.filter(node => node.revealTier <= tier)
  const sourceEdges = expansion.edges.flatMap((edge, index) => edge.revealTier <= tier ? [{
    id: `source-reference-${index}-${edge.from}-${edge.to}`,
    source: edge.from, target: edge.to, type: 'smoothstep', animated: false,
    className: 'edge-source-reference', markerEnd: { type: 'arrowclosed' },
    title: `源码引用：${edge.reason || ''}`, data: edge,
  }] : [])
  const edges = [...baseGraph.edges, ...sourceEdges]
  const incoming = new Map([...baseGraph.facts, ...additions].map(node => [node.id, []]))
  const outgoing = new Map([...baseGraph.facts, ...additions].map(node => [node.id, []]))
  for (const edge of edges) {
    const detail = { ...edge.data, from: edge.source, to: edge.target }
    incoming.get(edge.target).push(detail)
    outgoing.get(edge.source).push(detail)
  }
  const baseFacts = new Map(baseGraph.facts.map(node => [node.id, node]))
  const facts = [
    ...baseGraph.facts.map(node => ({ ...node, ownerId: node.id, revealTier: 0, isExpansion: false })),
    ...additions.map(node => ({
      ...node, title: clean(node.label) || node.declarationName,
      preview: clean(node.description), author: clean(node.author) || '—', assistant: clean(node.assistant),
      status: 'source', revoked: false, isExpansion: true,
      level: baseFacts.get(node.ownerId)?.level ?? 0,
    })),
  ].map(node => {
    const predecessors = [...new Set(incoming.get(node.id).map(edge => edge.from))]
    const children = [...new Set(outgoing.get(node.id).map(edge => edge.to))]
    return {
      ...node, predecessors, parents: predecessors, children, semanticTier: tier,
      isExpansionBoundary: node.isExpansion && (node.boundary?.isBoundary === true || node.revealTier === tier || !predecessors.length),
    }
  })
  const factById = new Map(facts.map(node => [node.id, node]))
  const factDetails = Object.fromEntries(facts.map(node => [node.id, {
    ...(node.isExpansion ? node : baseGraph.factDetails?.[node.id]),
    ownerId: node.ownerId, revealTier: node.revealTier, isExpansion: node.isExpansion,
    isExpansionBoundary: node.isExpansionBoundary,
    incoming: incoming.get(node.id), outgoing: outgoing.get(node.id),
  }]))
  const positions = expandedPositions(baseGraph, expansion.nodes, tier)
  const nodes = [
    ...baseGraph.nodes,
    ...additions.map(node => ({ id: node.id, type: 'fact' })),
  ].map(node => ({
    ...node, position: positions.get(node.id), data: factById.get(node.id),
    width: NODE_WIDTH, height: NODE_HEIGHT,
    style: { ...node.style, width: NODE_WIDTH, height: NODE_HEIGHT },
  }))
  const statusCounts = { green: 0, yellow: 0, red: 0, revoked: 0, unknown: 0, source: 0 }
  for (const node of facts) {
    const status = Object.hasOwn(statusCounts, node.status) ? node.status : 'unknown'
    statusCounts[status]++
  }
  const { nodes: _nodes, edges: _edges, ...expansionMetadata } = expansion
  return {
    ...baseGraph, nodes, edges, facts, factDetails, semanticTier: tier, isSemanticGraph: true,
    stats: {
      ...baseGraph.stats, total: facts.length, edges: edges.length,
      active: facts.filter(node => !node.revoked).length, revoked: facts.filter(node => node.revoked).length,
      roots: facts.filter(node => !node.predecessors.length).length,
      leaves: facts.filter(node => !node.children.length).length,
      dangling: 0, statusCounts,
    },
    source: {
      ...baseGraph.source,
      expansion: { ...expansionMetadata, tier, visibleNodes: additions.length, visibleEdges: sourceEdges.length },
    },
  }
}

/** Keep a selected shared declaration by identity; collapse to its canonical owner. */
export function collapsedSelection(selectedId, baseGraph, expansion, tier) {
  if (!selectedId) return null
  if (baseGraph.nodes.some(node => node.id === selectedId)) return selectedId
  const node = expansion?.nodes?.find(node => node.id === selectedId)
  if (!node) return null
  if (node.revealTier <= tier) return node.id
  return baseGraph.nodes.some(owner => owner.id === node.ownerId) ? node.ownerId : null
}

function nodeSize(node) {
  return {
    width: node.width ?? node.measured?.width ?? NODE_WIDTH,
    height: node.height ?? node.measured?.height ?? NODE_HEIGHT,
  }
}

function nodeCenter(node) {
  const { width, height } = nodeSize(node)
  return { x: node.position.x + width / 2, y: node.position.y + height / 2 }
}

/** screenPoint is local to the canvas, not a client/page coordinate. */
export function selectViewportAnchor(oldGraph, newGraph, viewport, size, preferredId = null, screenPoint = null) {
  const common = new Set(newGraph.nodes.map(node => node.id))
  const candidates = oldGraph.nodes.filter(node => common.has(node.id))
  if (!candidates.length) return null
  const screenRect = node => {
    const { width, height } = nodeSize(node)
    const x = node.position.x * viewport.zoom + viewport.x
    const y = node.position.y * viewport.zoom + viewport.y
    return { x, y, width: width * viewport.zoom, height: height * viewport.zoom }
  }
  const isVisible = node => {
    const rect = screenRect(node)
    return rect.x < size.width && rect.x + rect.width > 0 && rect.y < size.height && rect.y + rect.height > 0
  }
  const preferred = candidates.find(node => node.id === preferredId)
  if (preferred && isVisible(preferred)) return preferred.id
  const point = screenPoint || { x: size.width / 2, y: size.height / 2 }
  let nearest = null, distance = Infinity
  for (const node of candidates) {
    const center = nodeCenter(node)
    const dx = center.x * viewport.zoom + viewport.x - point.x
    const dy = center.y * viewport.zoom + viewport.y - point.y
    const next = dx * dx + dy * dy
    if (next < distance || (next === distance && node.id < nearest)) { nearest = node.id; distance = next }
  }
  return nearest
}

/** Translate the current viewport to preserve one common node center and zoom. */
export function preserveViewportAnchor(oldNode, newNode, viewport) {
  if (!oldNode || !newNode || oldNode.id !== newNode.id) throw new Error('Viewport anchor must have the same declaration identity')
  const oldCenter = nodeCenter(oldNode), newCenter = nodeCenter(newNode)
  return {
    x: viewport.x + (oldCenter.x - newCenter.x) * viewport.zoom,
    y: viewport.y + (oldCenter.y - newCenter.y) * viewport.zoom,
    zoom: viewport.zoom,
  }
}
