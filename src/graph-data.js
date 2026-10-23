// Pure adapters for the dashboard dependency snapshot and the original Danus data.
// A local verified deliverable does not imply its downstream theorem is proved.
const safeArray = value => Array.isArray(value) ? value : []
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim()
const statuses = {
  green: { key: 'green', label: '已核验', color: '#15986b' },
  yellow: { key: 'yellow', label: '进行中', color: '#bd8b16' },
  red: { key: 'red', label: '未完成', color: '#d34e59' },
  revoked: { key: 'revoked', label: '已撤销', color: '#d95563' },
  unknown: { key: 'unknown', label: '未知', color: '#7b879a' },
}
const edgeKinds = {
  source: '源码 / 接口前置',
  route: '当前证明路线',
  validation: '最终验收要求',
  component: '已核验组件',
  alternative: '替代路线',
}

export function statusInfo(nodeOrStatus) {
  const key = typeof nodeOrStatus === 'string' ? nodeOrStatus : nodeOrStatus?.status
  return statuses[key] || statuses.unknown
}

export function edgeKindLabel(kind) {
  return edgeKinds[kind] || kind || '依赖关系'
}

function assignLevels(nodes, strict) {
  const byId = new Map(nodes.map(node => [node.id, node]))
  if (byId.size !== nodes.length) throw new Error('图谱含重复节点 ID')
  const inDegree = new Map()
  const children = new Map(nodes.map(node => [node.id, []]))
  for (const node of nodes) {
    node.parents = [...new Set(node.predecessors.filter(id => byId.has(id)))]
    node.level = 0
    inDegree.set(node.id, node.parents.length)
    for (const id of node.parents) children.get(id).push(node.id)
  }
  const queue = nodes.filter(node => !inDegree.get(node.id)).sort((a, b) => a.id.localeCompare(b.id))
  for (let i = 0; i < queue.length; i++) {
    const parent = queue[i]
    for (const id of children.get(parent.id)) {
      const child = byId.get(id)
      child.level = Math.max(child.level, parent.level + 1)
      inDegree.set(id, inDegree.get(id) - 1)
      if (!inDegree.get(id)) queue.push(child)
    }
  }
  if (queue.length !== nodes.length && strict) throw new Error('证明依赖图含循环')
  // Retain the old Danus viewer's behavior for historical cyclic snapshots.
  if (!strict) nodes.filter(node => inDegree.get(node.id) > 0).forEach(node => { node.level = 1 })
  return nodes
}

function visualNodes(nodes) {
  const layers = new Map()
  for (const node of nodes) {
    if (!layers.has(node.level)) layers.set(node.level, [])
    layers.get(node.level).push(node)
  }
  return [...layers.keys()].sort((a, b) => a - b).flatMap(level => {
    const layer = layers.get(level).sort((a, b) => a.id.localeCompare(b.id))
    const span = Math.max(900, layer.length * 290)
    return layer.map((node, index) => ({
      id: node.id, type: 'fact',
      position: { x: index * 290 - span / 2, y: level * 250 },
      data: node,
    }))
  })
}

function countStatuses(nodes) {
  const counts = { green: 0, yellow: 0, red: 0, revoked: 0, unknown: 0 }
  for (const node of nodes) counts[statusInfo(node).key]++
  return counts
}

function dependencyData(raw, supplement) {
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) throw new Error('证明依赖快照缺少节点或连线')
  if (supplement.sourceCommit && supplement.sourceCommit !== raw.sourceCommit) throw new Error('图谱与节点详情的来源版本不一致')
  const known = new Set(raw.nodes.map(node => node.id))
  if (known.size !== raw.nodes.length || raw.nodes.some(node => typeof node.id !== 'string' || !node.id)) throw new Error('证明依赖节点 ID 无效或重复')
  const incoming = new Map(raw.nodes.map(node => [node.id, []]))
  const outgoing = new Map(raw.nodes.map(node => [node.id, []]))
  for (const edge of raw.edges) {
    if (!known.has(edge.from) || !known.has(edge.to)) throw new Error('证明依赖连线缺少端点')
    incoming.get(edge.to).push(edge)
    outgoing.get(edge.from).push(edge)
  }
  const facts = assignLevels(raw.nodes.map(node => ({
    ...node,
    title: clean(node.label) || node.id,
    author: clean(node.author) || '—',
    assistant: clean(node.assistant),
    preview: clean(node.description),
    revoked: false,
    status: ['green', 'yellow', 'red'].includes(node.status) ? node.status : 'unknown',
    predecessors: [...new Set(incoming.get(node.id).map(edge => edge.from))],
    children: [...new Set(outgoing.get(node.id).map(edge => edge.to))],
  })), true)
  const factDetails = Object.fromEntries(raw.nodes.map(node => {
    const detail = { ...node }
    const extra = supplement.nodes?.[node.id]
    if (Array.isArray(extra?.criteria)) detail.criteria = extra.criteria
    if (Array.isArray(extra?.links)) detail.links = extra.links
    detail.incoming = incoming.get(node.id)
    detail.outgoing = outgoing.get(node.id)
    return [node.id, detail]
  }))
  const edges = raw.edges.map((edge, index) => ({
    id: `dependency-${index}-${edge.from}-${edge.to}-${edge.kind}`,
    source: edge.from, target: edge.to, type: 'smoothstep', animated: false,
    className: `edge-${edge.kind}`,
    markerEnd: { type: 'arrowclosed' },
    title: `${edgeKindLabel(edge.kind)}：${edge.reason || ''}`,
    data: edge,
  }))
  const { nodes: _nodes, edges: _edges, ...metadata } = raw
  return {
    nodes: visualNodes(facts), edges, facts, factDetails,
    stats: {
      total: facts.length, edges: edges.length,
      active: facts.length, revoked: 0,
      roots: facts.filter(node => !node.predecessors.length).length,
      leaves: facts.filter(node => !node.children.length).length,
      dangling: 0, statusCounts: countStatuses(facts),
    },
    project: '1+1.75 · 形式化全图',
    isDependencyGraph: true,
    source: {
      ...metadata,
      snapshotAt: supplement.snapshotAt || raw.reviewedAt,
      dashboardUrl: supplement.dashboardUrl,
      sourceFiles: supplement.sourceFiles,
    },
  }
}

function legacyData(raw) {
  const facts = assignLevels(safeArray(raw.nodes).filter(node => node && node.id).map(node => ({
    ...node,
    title: clean(node.title) || 'Untitled fact',
    author: clean(node.author) || 'unknown',
    assistant: clean(node.assistant),
    preview: clean(node.statement_preview),
    revoked: !!node.revoked,
    // Danus's original schema uses revoked rather than the dashboard's three statuses.
    status: node.revoked ? 'revoked' : 'green',
    predecessors: [...safeArray(node.predecessors)],
    children: [...safeArray(node.children)],
  })), false)
  const known = new Set(facts.map(node => node.id))
  const edges = facts.flatMap(node => node.predecessors.filter(id => known.has(id)).map((id, index) => ({
    id: `legacy-${id}-${node.id}-${index}`,
    source: id, target: node.id, type: 'smoothstep', animated: false,
    className: node.revoked ? 'edge-revoked' : '', markerEnd: { type: 'arrowclosed' },
  })))
  return {
    nodes: visualNodes(facts), edges, facts,
    factDetails: raw.facts && typeof raw.facts === 'object' ? raw.facts : {},
    stats: { ...raw.stats, statusCounts: countStatuses(facts) },
    project: clean(raw.problem_id) || 'Fact Graph',
    isDependencyGraph: false,
    source: { version: raw.version, generatedAt: raw.generated_at, attribution: raw.attribution },
  }
}

export function flowData(raw, supplement = {}) {
  return raw?.schema === 'goldbach-task-dependencies-v1' ? dependencyData(raw, supplement) : legacyData(raw || {})
}
