import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Background, Controls, Handle, MiniMap, Panel, Position, ReactFlow, useReactFlow } from '@xyflow/react'
import {
  buildSemanticGraph, collapsedSelection, NODE_HEIGHT, NODE_WIDTH,
  preserveViewportAnchor, resolveSemanticTier, selectViewportAnchor, TIER_ZOOMS,
} from './semantic-zoom.js'
import './semantic-zoom.css'

const LABELS = ['总览', '定理引用', '声明细节']
const DESCRIPTIONS = ['42 个阅读入口', '展开第一层源码引用', '继续展开下一层源码引用']
const compact = (value, max) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max) + '…' : text
}

function ProofNode({ data, selected }) {
  const expanded = data.isExpansion || String(data.id).startsWith('decl:')
  const boundary = data.isExpansionBoundary || !data.predecessors.length
  return <div className={'fact-node semantic-node status-source' + (expanded ? ' semantic-declaration' : ' semantic-overview-node') + (selected ? ' selected' : '') + (data.group === 'audit' ? ' audit-entry' : '')}>
    <Handle type="target" position={Position.Top} className="port"/>
    <div className="node-cap"><span className="node-state">源码可追溯</span><span>{expanded ? (data.revealTier === 2 ? '进一步引用' : '直接引用') : (data.group === 'audit' ? '审查入口' : '总览节点')}</span></div>
    <strong title={data.title}>{compact(data.title, 90)}</strong>
    <p title={data.declarationName || data.preview}>{compact(expanded ? data.module : data.preview, 100)}</p>
    <footer><span>{boundary ? '当前展开边界' : `${data.predecessors.length} 项前置引用`}</span><span>{data.children.length} 项后续</span></footer>
    <Handle type="source" position={Position.Bottom} className="port"/>
  </div>
}
const nodeTypes = { fact: ProofNode }

/** The three graphs share declaration IDs; a transition changes only the
 * visible level of detail and the translation needed to keep an anchor still. */
export default function SemanticProofCanvas({ baseGraph, selectedId, onSelect, onGraphChange, dark, controllerRef }) {
  const flow = useReactFlow()
  const containerRef = useRef(null)
  const mounted = useRef(true)
  const graphsRef = useRef([baseGraph])
  const expansionRef = useRef(null)
  const graphRef = useRef(baseGraph)
  const tierRef = useRef(0)
  const selectedRef = useRef(selectedId)
  const pointerRef = useRef(null)
  const pendingRef = useRef(null)
  const requestedTierRef = useRef(null)
  const transitionRef = useRef(null)
  const loadRef = useRef(null)
  const requestRef = useRef(null)
  const loadStateRef = useRef('idle')
  const programmaticRef = useRef(false)
  const viewportEpochRef = useRef(0)
  const focusEpochRef = useRef(0)
  const initializedRef = useRef(false)
  const [tier, setTier] = useState(0)
  const [graphs, setGraphs] = useState([baseGraph])
  const [ready, setReady] = useState(false)
  const [zoom, setZoom] = useState(.24)
  const [loadState, setLoadState] = useState('idle')
  const [loadError, setLoadError] = useState('')
  const graph = graphs[tier] || baseGraph
  selectedRef.current = selectedId

  const viewportSize = () => ({ width: containerRef.current?.clientWidth || 1, height: containerRef.current?.clientHeight || 1 })
  const guardedViewport = useCallback(viewport => {
    const epoch = ++viewportEpochRef.current
    programmaticRef.current = true
    setZoom(viewport.zoom)
    Promise.resolve(flow.setViewport(viewport, { duration: 0 })).finally(() => {
      if (mounted.current && viewportEpochRef.current === epoch) programmaticRef.current = false
    })
  }, [flow.setViewport])

  const transition = useCallback((next, options = {}) => {
    const oldGraph = pendingRef.current?.oldGraph || graphRef.current
    const newGraph = graphsRef.current[next]
    if (!newGraph) {
      requestedTierRef.current = { tier: next, ...options }
      loadRef.current?.()
      return
    }
    requestedTierRef.current = null
    if (next === tierRef.current) {
      if (options.focusId) {
        const node = newGraph.nodes.find(item => item.id === options.focusId)
        if (node) {
          const epoch = ++focusEpochRef.current
          onSelect(node.data)
          // Let the inspector take its width before calculating the new center.
          requestAnimationFrame(() => {
            if (!mounted.current || focusEpochRef.current !== epoch || selectedRef.current !== node.id) return
            const size = viewportSize()
            const nextZoom = options.zoom ?? flow.getZoom()
            guardedViewport({ x: size.width / 2 - (node.position.x + NODE_WIDTH / 2) * nextZoom, y: size.height / 2 - (node.position.y + NODE_HEIGHT / 2) * nextZoom, zoom: nextZoom })
          })
        }
      } else if (options.zoom !== undefined) {
        flow.zoomTo(options.zoom, { duration: 220 })
      }
      return
    }
    const viewport = flow.getViewport()
    const screenPoint = options.pointer || pointerRef.current
    const preferredId = options.focusId || (screenPoint ? null : selectedRef.current)
    const anchorId = selectViewportAnchor(oldGraph, newGraph, viewport, viewportSize(), preferredId, screenPoint)
    pendingRef.current = { oldGraph, newGraph, anchorId, ...options }
    tierRef.current = next
    graphRef.current = newGraph
    setTier(next)
    const restoredId = collapsedSelection(selectedRef.current, baseGraph, expansionRef.current, next)
    const restored = newGraph.nodes.find(node => node.id === (options.focusId || restoredId))
    if (selectedRef.current || options.focusId) onSelect(restored?.data || null)
  }, [baseGraph, flow.getViewport, flow.getZoom, flow.zoomTo, onSelect, guardedViewport])
  transitionRef.current = transition

  const loadExpansion = useCallback((retry = false) => {
    if (requestRef.current || expansionRef.current || (loadStateRef.current === 'error' && !retry)) return
    const controller = new AbortController()
    requestRef.current = controller
    loadStateRef.current = 'loading'
    setLoadState('loading'); setLoadError('')
    fetch(import.meta.env.BASE_URL + 'riemann-expansion.json', { signal: controller.signal, cache: 'no-store' })
      .then(response => {
        if (!response.ok) throw new Error(`声明引用数据读取失败（HTTP ${response.status}）`)
        return response.json()
      })
      .then(raw => {
        if (!mounted.current || controller.signal.aborted || requestRef.current !== controller) return
        const prepared = [baseGraph, buildSemanticGraph(baseGraph, raw, 1), buildSemanticGraph(baseGraph, raw, 2)]
        expansionRef.current = raw
        graphsRef.current = prepared
        loadStateRef.current = 'ready'
        setGraphs(prepared); setLoadState('ready')
        const pending = requestedTierRef.current
        // Wheel may have crossed both bands, or returned to overview, during fetch.
        const currentZoom = flow.getZoom()
        const desired = pending?.manual ? pending.tier : resolveSemanticTier(currentZoom, tierRef.current)
        if (desired !== tierRef.current || pending?.focusId) transitionRef.current(desired, pending?.manual ? pending : {})
      })
      .catch(error => {
        if (!mounted.current || controller.signal.aborted) return
        loadStateRef.current = 'error'
        setLoadError(error.message || '声明引用数据读取失败'); setLoadState('error')
      })
      .finally(() => { if (requestRef.current === controller) requestRef.current = null })
  }, [baseGraph, flow.getZoom])
  loadRef.current = loadExpansion

  useEffect(() => () => {
    mounted.current = false
    requestRef.current?.abort()
    if (controllerRef) controllerRef.current = null
  }, [controllerRef])

  useLayoutEffect(() => {
    graphRef.current = graph
    const pending = pendingRef.current
    if (!pending || pending.newGraph !== graph) return
    pendingRef.current = null
    const oldNode = pending.oldGraph.nodes.find(node => node.id === pending.anchorId)
    const newNode = graph.nodes.find(node => node.id === pending.anchorId)
    if (oldNode && newNode) {
      const current = flow.getViewport()
      let next = preserveViewportAnchor(oldNode, newNode, current)
      if (pending.zoom !== undefined) {
        const screenX = oldNode.position.x * current.zoom + current.x + NODE_WIDTH / 2 * current.zoom
        const screenY = oldNode.position.y * current.zoom + current.y + NODE_HEIGHT / 2 * current.zoom
        next = { x: screenX - (newNode.position.x + NODE_WIDTH / 2) * pending.zoom, y: screenY - (newNode.position.y + NODE_HEIGHT / 2) * pending.zoom, zoom: pending.zoom }
      }
      guardedViewport(next)
    }
    if (pending.focusId) {
      const target = graph.nodes.find(node => node.id === pending.focusId)
      if (target) {
        onSelect(target.data)
        const size = viewportSize()
        const nextZoom = pending.zoom ?? flow.getZoom()
        guardedViewport({ x: size.width / 2 - (target.position.x + NODE_WIDTH / 2) * nextZoom, y: size.height / 2 - (target.position.y + NODE_HEIGHT / 2) * nextZoom, zoom: nextZoom })
      }
    }
    // A fast wheel gesture can cross the second boundary before React commits
    // the first transition. Reconcile the latest zoom after installing it.
    const reconciled = resolveSemanticTier(pending.zoom ?? flow.getZoom(), tierRef.current)
    if (reconciled !== tierRef.current && graphsRef.current[reconciled]) transitionRef.current(reconciled)
  }, [graph, flow.getViewport, flow.getZoom, guardedViewport, onSelect])

  useEffect(() => { onGraphChange(graph) }, [graph, onGraphChange])

  useEffect(() => {
    if (!ready || initializedRef.current) return
    initializedRef.current = true
    const frame = requestAnimationFrame(() => {
      const epoch = ++viewportEpochRef.current
      programmaticRef.current = true
      Promise.resolve(flow.fitView({ nodes: baseGraph.nodes, padding: .13, minZoom: .04, maxZoom: .30, duration: 0 })).finally(() => {
        if (mounted.current && viewportEpochRef.current === epoch) { programmaticRef.current = false; setZoom(flow.getZoom()) }
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [ready, baseGraph, flow.fitView, flow.getZoom])

  const handleMove = useCallback((event, viewport) => {
    setZoom(viewport.zoom)
    if (programmaticRef.current || pendingRef.current || !initializedRef.current) return
    const next = resolveSemanticTier(viewport.zoom, tierRef.current)
    if (next !== tierRef.current) transitionRef.current(next)
    else if (next === 0 && requestedTierRef.current && !requestedTierRef.current.manual) requestedTierRef.current = null
  }, [])

  const chooseTier = useCallback(next => {
    pointerRef.current = null
    transitionRef.current(next, { zoom: TIER_ZOOMS[next], manual: true })
  }, [])

  const resetOverview = useCallback(() => {
    requestedTierRef.current = null
    if (tierRef.current !== 0) transitionRef.current(0, { zoom: TIER_ZOOMS[0], manual: true })
    pointerRef.current = null
    // This is the user's explicit reset; ordinary tier transitions never fit.
    requestAnimationFrame(() => {
      if (!mounted.current) return
      const epoch = ++viewportEpochRef.current
      programmaticRef.current = true
      Promise.resolve(flow.fitView({ nodes: baseGraph.nodes, padding: .13, minZoom: .04, maxZoom: .30, duration: 0 })).finally(() => {
        if (mounted.current && viewportEpochRef.current === epoch) { programmaticRef.current = false; setZoom(flow.getZoom()) }
      })
    })
  }, [baseGraph, flow.fitView, flow.getZoom])

  useEffect(() => {
    controllerRef.current = {
      getSearchGraph: () => graphsRef.current[2] || graphRef.current,
      focus: id => {
        const found = (graphsRef.current[2] || graphRef.current).nodes.find(node => node.id === id)
        if (!found) return false
        const needed = found.data.revealTier || 0
        const next = Math.max(tierRef.current, needed)
        pointerRef.current = null
        transitionRef.current(next, { focusId: id, zoom: next === 0 ? .44 : TIER_ZOOMS[next], manual: true })
        return true
      },
    }
  }, [controllerRef])

  const nodes = useMemo(() => graph.nodes.map(node => ({ ...node, width: NODE_WIDTH, height: NODE_HEIGHT, style: { ...node.style, width: NODE_WIDTH, height: NODE_HEIGHT }, selected: node.id === selectedId })), [graph, selectedId])
  const captureWheel = event => {
    focusEpochRef.current++
    const rect = containerRef.current?.getBoundingClientRect()
    if (rect) pointerRef.current = { x: event.clientX - rect.left, y: event.clientY - rect.top }
    if (requestedTierRef.current?.manual) requestedTierRef.current = null
  }

  return <div className="semantic-canvas" ref={containerRef} onWheelCapture={captureWheel} data-semantic-tier={tier} data-node-count={graph.facts.length} data-edge-count={graph.edges.length}>
    <ReactFlow nodes={nodes} edges={graph.edges} nodeTypes={nodeTypes} minZoom={.04} maxZoom={2.5} onInit={() => setReady(true)} onMoveStart={event => { if (!programmaticRef.current && event?.type !== 'wheel') pointerRef.current = null }} onMove={handleMove} nodesDraggable={false} nodesConnectable={false} onlyRenderVisibleElements={tier > 0} onNodeClick={(_, node) => onSelect(node.data)} proOptions={{ hideAttribution: true }}>
      <Background gap={20} size={1} color={dark ? '#243248' : '#dfe6ee'}/>
      <Controls showInteractive={false} showFitView={false}/>
      <MiniMap nodeColor={node => node.data.isExpansion ? (node.data.revealTier === 2 ? '#79a4ab' : '#91a5d6') : '#526cff'} nodeStrokeColor={dark ? '#111b2c' : '#ffffff'} nodeStrokeWidth={4} nodeBorderRadius={7} bgColor={dark ? '#111b2c' : '#ffffff'} maskColor={dark ? 'rgba(116,139,255,.18)' : 'rgba(82,108,255,.10)'} maskStrokeColor="#7185e8" maskStrokeWidth={2} zoomable pannable/>
      <Panel position="top-left" className="semantic-toolbar" aria-label="图谱缩放粒度">
        <div className="semantic-toolbar-heading"><span>随缩放展开</span><output aria-label="当前缩放比例">{Math.round(zoom * 100)}%</output></div>
        <div className="semantic-tier-buttons" role="group" aria-label="选择图谱粒度">
          {LABELS.map((label, index) => <button key={label} className={tier === index ? 'active' : ''} aria-pressed={tier === index} onClick={() => chooseTier(index)}><small>{index + 1}</small>{label}</button>)}
        </div>
        <div className="semantic-counts" role="status"><b>{graph.facts.length.toLocaleString()}</b> 节点 <span>·</span> <b>{graph.edges.length.toLocaleString()}</b> 关系 <span>·</span> {DESCRIPTIONS[tier]}</div>
        {loadState === 'loading' && <p className="semantic-load" role="status">正在读取更细的声明引用，当前图仍可浏览…</p>}
        {loadState === 'error' && <p className="semantic-load error" role="alert">{loadError}<button onClick={() => loadExpansion(true)}>重新读取</button></p>}
      </Panel>
      <Panel position="top-right" className="semantic-reset"><button onClick={resetOverview} aria-label="返回42节点总览">↖ 返回总览</button></Panel>
      <Panel position="bottom-left" className="semantic-note">
        <b>{tier === 0 ? '滚轮放大，逐层展开前置引用' : '源码引用展开 · 前置 → 使用该前置的声明'}</b>
        <span>{tier === 0 ? '总览 → 定理引用 → 声明细节；缩小时自动收拢。' : '当前展开边界仍可能有前置；本层不是 Lean 内核的完整证明依赖。'}</span>
      </Panel>
    </ReactFlow>
  </div>
}
