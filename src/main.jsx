import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { applyNodeChanges, Background, Controls, Handle, MiniMap, Panel, Position, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react'
import { flowData, statusInfo } from './graph-data.js'
import DependencyInspector from './DependencyInspector.jsx'
import '@xyflow/react/dist/style.css'
import './style.css'
import './proof-graph.css'

const safeArray = value => Array.isArray(value) ? value : []
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim()
const clip = (value, length) => clean(value).slice(0, length) + (clean(value).length > length ? '…' : '')
const DATASETS = {
  goldbach: { label: '1+1.75 · 当前看板全图', graph: 'goldbach-graph.json', details: 'goldbach-details.json' },
  danus: { label: 'Danus · 原事实快照', graph: 'fact-graph.json' },
}
const initialDataset = () => {
  const value = new URLSearchParams(window.location.search).get('graph')
  return Object.hasOwn(DATASETS, value) ? value : 'goldbach'
}

async function writeClipboard(value) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value)
  const area = document.createElement('textarea')
  area.value = value
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  const copied = document.execCommand('copy')
  area.remove()
  if (!copied) throw new Error('copy failed')
}

function kind(node) {
  if (node.revoked) return 'revoked'
  if (!node.predecessors.length && !node.children.length) return 'isolated'
  if (!node.predecessors.length) return 'root'
  if (!node.children.length) return 'leaf'
  return 'fact'
}

function FactNode({ data, selected }) {
  const status = statusInfo(data)
  return <div className={'fact-node ' + kind(data) + ' status-' + status.key + (selected ? ' selected' : '')}>
    <Handle type="target" position={Position.Top} className="port"/>
    <div className="node-cap"><span className="node-state">{status.label}</span><span className="node-level">L{data.level}</span></div>
    <strong>{clip(data.title, 54)}</strong><p>{clip(data.preview || data.title, 90)}</p>
    <footer><code title={data.id}>{clip(data.id, 24)}</code><span>← {data.predecessors.length} · {data.children.length} →</span></footer>
    <Handle type="source" position={Position.Bottom} className="port"/>
  </div>
}
const nodeTypes = { fact: FactNode }

// Retain the original Danus statement/proof/glossary and copy tools.
function Inspector({ node, facts, onClose, onJump }) {
  const [copyState, setCopyState] = useState('')
  useEffect(() => { setCopyState('') }, [node?.id])
  if (!node) return null
  const detail = facts[node.id]
  const refs = safeArray(detail?.external_refs)
  const glossary = detail?.glossary && typeof detail.glossary === 'object' ? detail.glossary : {}
  const glossaryText = Object.entries(glossary).map(([key, value]) => key + ': ' + value).join('\n')
  const contentText = 'id:' + node.id + '\nGlossary：' + glossaryText + '\nStatement：' + (detail?.statement || '') + '\nProof：' + (detail?.proof || '')
  const fullText = JSON.stringify({
    id: node.id, title: node.title, author: node.author, assistant: node.assistant,
    statement_preview: node.preview, revoked: node.revoked, status: node.status,
    type: kind(node).toUpperCase(), level: node.level,
    predecessors: node.predecessors, children: node.children, detail,
  }, null, 2)
  const copyBundle = async type => {
    if (!detail) return
    try {
      await writeClipboard(type === 'full' ? fullText : contentText)
      setCopyState(type)
      setTimeout(() => setCopyState(''), 1200)
    } catch { setCopyState('failed') }
  }
  const status = statusInfo(node)
  return <aside className="inspector">
    <header><div><small>FACT INSPECTOR · SNAPSHOT</small><h2>{node.title}</h2></div><button onClick={onClose} aria-label="关闭节点详情">×</button></header>
    <div className="pills"><b className={'status-' + status.key}>{status.label}</b><b>{kind(node).toUpperCase()}</b></div>
    <div className="copy-actions"><button type="button" disabled={!detail} onClick={() => copyBundle('content')}>{copyState === 'content' ? '已复制' : '单内容复制'}</button><button type="button" disabled={!detail} onClick={() => copyBundle('full')}>{copyState === 'full' ? '已复制' : '完整复制'}</button></div>
    {copyState === 'failed' && <p className="error" role="status">复制失败，请重试。</p>}
    <code className="fact-id">{node.id}</code>
    <div className="meta"><span>作者<b>{node.author}</b></span><span>辅助<b>{node.assistant || clean(detail?.assistant) || '—'}</b></span><span>前置<b>{node.predecessors.length}</b></span><span>后续<b>{node.children.length}</b></span></div>
    <section><h3>前置依赖</h3>{node.predecessors.length ? node.predecessors.map(id => <button className="relation" key={id} onClick={() => onJump(id)}>{id}</button>) : <i>无</i>}</section>
    <section><h3>后续节点</h3>{node.children.length ? node.children.map(id => <button className="relation" key={id} onClick={() => onJump(id)}>{id}</button>) : <i>无</i>}</section>
    {!detail ? <p className="muted">快照未包含该节点详情。</p> : <>
      <Details title="Statement" value={detail.statement} open copyable/>
      <Details title="Proof" value={detail.proof} copyable/>
      <Details title="Glossary" value={glossaryText} copyable/>
      <Details title="References" value={refs.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join('\n')}/>
    </>}
  </aside>
}

function Details({ title, value, open, copyable = false }) {
  const [copied, setCopied] = useState(false)
  const copy = async event => {
    event.preventDefault()
    event.stopPropagation()
    try { await writeClipboard(value); setCopied(true); setTimeout(() => setCopied(false), 1200) }
    catch { setCopied(false) }
  }
  return value ? <details open={open}><summary><span>{title}</span>{copyable && <button className="copy-detail" type="button" onClick={copy} aria-label={'复制 ' + title}>{copied ? '已复制' : '复制'}</button>}</summary><pre>{value}</pre></details> : null
}

function LevelNavigator({ level, max, onChange }) {
  if (max < 1) return null
  const move = delta => onChange(Math.max(0, Math.min(max, level + delta)))
  const wheel = event => { event.preventDefault(); event.stopPropagation(); move(event.deltaY > 0 ? 1 : -1) }
  return <Panel position="top-right" className="level-nav" onWheel={wheel}><b>L{level}</b><button type="button" onClick={() => onChange(0)} title="跳到第一层">L0</button><input type="range" min="0" max={max} value={level} onChange={event => onChange(Number(event.target.value))} aria-label={'当前层级 ' + level + '，共 ' + (max + 1) + ' 层'}/><button type="button" onClick={() => onChange(max)} title="跳到最后一层">L{max}</button></Panel>
}

function Canvas() {
  const [dataset, setDataset] = useState(initialDataset)
  const [reload, setReload] = useState(0)
  const [graph, setGraph] = useState(null)
  const [selected, setSelected] = useState(null)
  const [error, setError] = useState('')
  const [flowReady, setFlowReady] = useState(false)
  const [activeLevel, setActiveLevel] = useState(0)
  const [searchId, setSearchId] = useState('')
  const [searchError, setSearchError] = useState('')
  const [dark, setDark] = useState(() => {
    try { const saved = localStorage.getItem('fact-graph-theme'); return saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches }
    catch { return false }
  })
  const canvasRef = useRef(null)
  const { fitView, setCenter, getZoom } = useReactFlow()
  const load = useCallback(() => setReload(value => value + 1), [])
  const onNodesChange = useCallback(changes => {
    // Persist measured sizes in controlled nodes so MiniMap can render them.
    // Selection is derived from the inspector and must not reset the viewport.
    const dimensions = changes.filter(change => change.type === 'dimensions')
    if (dimensions.length) setGraph(current => current ? {
      ...current, nodes: applyNodeChanges(dimensions, current.nodes),
    } : current)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const specification = DATASETS[dataset]
    setGraph(null); setSelected(null); setError(''); setSearchId(''); setSearchError(''); setFlowReady(false); setActiveLevel(0)
    const fetchJson = async filename => {
      const response = await fetch(import.meta.env.BASE_URL + filename, { cache: 'no-store', signal: controller.signal })
      if (!response.ok) throw new Error('无法读取快照 ' + filename + '（HTTP ' + response.status + '）')
      return response.json()
    }
    Promise.all([fetchJson(specification.graph), specification.details ? fetchJson(specification.details) : Promise.resolve({})])
      .then(([raw, supplement]) => { if (!controller.signal.aborted) setGraph(flowData(raw, supplement)) })
      .catch(cause => { if (!controller.signal.aborted) setError(cause.message || '图谱读取失败') })
    return () => controller.abort()
  }, [dataset, reload])

  useEffect(() => {
    const url = new URL(window.location.href)
    url.searchParams.set('graph', dataset)
    window.history.replaceState(window.history.state, '', url)
  }, [dataset])
  useEffect(() => {
    const restore = () => setDataset(initialDataset())
    window.addEventListener('popstate', restore)
    return () => window.removeEventListener('popstate', restore)
  }, [])
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    try { localStorage.setItem('fact-graph-theme', dark ? 'dark' : 'light') } catch {}
  }, [dark])
  const maxLevel = useMemo(() => graph ? Math.max(0, ...graph.facts.map(node => node.level)) : 0, [graph])
  const renderedNodes = useMemo(() => graph ? graph.nodes.map(node => ({ ...node, selected: node.id === selected?.id })) : [], [graph, selected])
  useEffect(() => {
    if (graph && flowReady) {
      const timer = setTimeout(() => fitView({ padding: .12, duration: 450, minZoom: .04, maxZoom: .72 }), 80)
      return () => clearTimeout(timer)
    }
  }, [graph, flowReady, fitView])
  useEffect(() => setActiveLevel(level => Math.min(level, maxLevel)), [maxLevel])
  const jump = useCallback(id => {
    const node = graph?.nodes.find(item => item.id === id)
    if (node) setSelected(node.data)
  }, [graph])
  const locateId = useCallback(event => {
    event?.preventDefault()
    const query = searchId.trim().toLocaleLowerCase()
    if (!query) { setSearchError('请输入节点名称、ID 或模块路径'); return }
    const exact = graph?.nodes.find(node => node.id.toLocaleLowerCase() === query)
    const matches = exact ? [exact] : graph?.nodes.filter(({ data }) => {
      const evidence = [...safeArray(data.evidence), ...safeArray(graph.factDetails[data.id]?.links)].map(item => [item.path, item.label, item.url].filter(Boolean).join(' ')).join(' ')
      return [data.id, data.title, data.preview, evidence].join(' ').toLocaleLowerCase().includes(query)
    }) || []
    if (matches.length === 1) { setSearchError(''); jump(matches[0].id) }
    else setSearchError(matches.length ? '匹配 ' + matches.length + ' 个节点，请补充名称或 ID' : '未找到匹配节点')
  }, [graph, searchId, jump])
  const goLevel = useCallback(level => {
    if (!graph) return
    const next = Math.max(0, Math.min(maxLevel, level))
    const layer = graph.nodes.filter(node => node.data.level === next)
    const x = layer.reduce((sum, node) => sum + node.position.x + 121, 0) / Math.max(1, layer.length)
    setActiveLevel(next); setCenter(x, next * 250 + 70, { zoom: getZoom() })
  }, [graph, maxLevel, getZoom, setCenter])
  const syncLevel = useCallback((_, viewport) => {
    const height = canvasRef.current?.clientHeight
    if (!height) return
    const centerY = (height / 2 - viewport.y) / viewport.zoom
    setActiveLevel(Math.max(0, Math.min(maxLevel, Math.round((centerY - 70) / 250))))
  }, [maxLevel])
  useEffect(() => {
    if (!selected || !graph) return
    const node = graph.nodes.find(item => item.id === selected.id)
    if (!node) return
    const frame = requestAnimationFrame(() => setCenter(node.position.x + 120, node.position.y + 70, { zoom: .86, duration: 350 }))
    return () => cancelAnimationFrame(frame)
  }, [selected, graph, setCenter])
  const sourceCommit = graph?.source?.sourceCommit
  const sourceUrl = /^[a-f0-9]{40}$/i.test(sourceCommit || '') ? 'https://github.com/UyNewNas/goldbach-formalization/commit/' + sourceCommit : null
  const statusKeys = graph?.isDependencyGraph ? ['green', 'yellow', 'red'] : ['green', 'revoked']

  return <div className="shell">
    <header className="bar">
      <div className="brand"><i></i><b>Fact Graph</b><span>{graph?.project || DATASETS[dataset].label}</span></div>
      <select className="dataset-select" value={dataset} onChange={event => setDataset(event.target.value)} aria-label="图谱数据集">{Object.entries(DATASETS).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}</select>
      <form className="id-search" onSubmit={locateId}><input value={searchId} onChange={event => { setSearchId(event.target.value); setSearchError('') }} placeholder="搜索节点名称、ID 或模块路径" aria-label="搜索节点名称、ID 或模块路径"/><button type="submit" disabled={!graph}>定位</button>{searchError && <span role="status">{searchError}</span>}</form>
      <div className="search">只读依赖画布 · 静态快照</div>
      <button className="theme-toggle" onClick={() => setDark(value => !value)} aria-pressed={dark}>{dark ? '日间模式' : '夜间模式'}</button>
      <button onClick={load}>重新载入</button>
    </header>
    <main className="workspace">
      {graph && (graph.isDependencyGraph
        ? <DependencyInspector key={selected?.id || 'none'} node={selected} graph={graph} onClose={() => setSelected(null)} onJump={jump} writeClipboard={writeClipboard}/>
        : <Inspector key={selected?.id || 'none'} node={selected} facts={graph.factDetails} onClose={() => setSelected(null)} onJump={jump}/>)}
      <div className="canvas" ref={canvasRef}>
        {error ? <div className="fatal"><h2>无法读取图谱</h2><p>{error}</p><button onClick={load}>重试</button></div>
          : !graph ? <div className="loading" role="status">读取 {DATASETS[dataset].label}…</div>
          : <ReactFlow nodes={renderedNodes} edges={graph.edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} minZoom={.04} fitView fitViewOptions={{ padding: .12, minZoom: .04, maxZoom: .72 }} onInit={() => setFlowReady(true)} onMoveEnd={syncLevel} nodesDraggable={false} onNodeClick={(_, node) => jump(node.id)} proOptions={{ hideAttribution: true }}>
            <Background gap={16} size={1} color={dark ? '#243248' : '#dfe6ee'}/>
            <Controls showInteractive={false}/>
            <MiniMap nodeColor={node => statusInfo(node.data).color} nodeStrokeColor={dark ? '#111b2c' : '#ffffff'} nodeStrokeWidth={5} nodeBorderRadius={8} bgColor={dark ? '#111b2c' : '#ffffff'} maskColor={dark ? 'rgba(116,139,255,.18)' : 'rgba(82,108,255,.10)'} maskStrokeColor={dark ? '#8b9cff' : '#526cff'} maskStrokeWidth={2} zoomable pannable/>
            <LevelNavigator level={activeLevel} max={maxLevel} onChange={goLevel}/>
            <Panel position="top-left" className="overview">
              <b>{graph.facts.length}</b><span>{graph.isDependencyGraph ? '个交付物' : '个事实节点'}</span><b>{graph.edges.length}</b><span>条关系</span>
              <div className="status-legend">{statusKeys.map(key => <span className={'status-' + key} key={key}><i/>{graph.stats.statusCounts[key]} {statusInfo(key).label}</span>)}</div>
            </Panel>
            <Panel position="bottom-left" className="snapshot-note">
              {graph.isDependencyGraph ? <>
                <span>依赖快照 {sourceUrl ? <a href={sourceUrl} target="_blank" rel="noopener noreferrer">{sourceCommit.slice(0, 8)}</a> : '—'} · 前置 → 使用该前置的目标</span>
                <p className="snapshot-caveat">节点是关键交付物，不等于 Lean 模块；数量不用于计算总体完成率。替代路线单独标注。</p>
              </> : <span>Danus 原始事实快照 · {graph.source.generatedAt?.slice(0, 10) || '历史数据'}</span>}
            </Panel>
          </ReactFlow>}
      </div>
    </main>
  </div>
}

createRoot(document.getElementById('root')).render(<ReactFlowProvider><Canvas/></ReactFlowProvider>)
