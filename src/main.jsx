import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Background, Controls, Handle, MiniMap, Panel, Position, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './style.css'

const safeArray = (v) => Array.isArray(v) ? v : []
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim()
const clip = (v, n) => clean(v).slice(0, n) + (clean(v).length > n ? '…' : '')
async function writeClipboard(value) {
  if(navigator.clipboard?.writeText)return navigator.clipboard.writeText(value)
  const area=document.createElement('textarea');area.value=value;area.style.position='fixed';area.style.opacity='0';document.body.appendChild(area);area.select();const copied=document.execCommand('copy');area.remove();if(!copied)throw new Error('copy failed')
}
function kind(n) { if (n.revoked) return 'revoked'; if (!n.predecessors.length && !n.children.length) return 'isolated'; if (!n.predecessors.length) return 'root'; if (!n.children.length) return 'leaf'; return 'fact' }
function levels(nodes) {
  const byId = new Map(nodes.map(n => [n.id, n])); const inDegree = new Map(); const next = new Map(nodes.map(n => [n.id, []]));
  nodes.forEach(n => { const parents = [...new Set(n.predecessors.filter(p => byId.has(p)))]; n.parents = parents; n.level = 0; inDegree.set(n.id, parents.length); parents.forEach(p => next.get(p).push(n.id)) })
  const queue = nodes.filter(n => !inDegree.get(n.id)).sort((a,b) => a.id.localeCompare(b.id));
  for (let i=0; i<queue.length; i++) { const n=queue[i]; next.get(n.id).forEach(id => { const c=byId.get(id); c.level=Math.max(c.level,n.level+1); inDegree.set(id,inDegree.get(id)-1); if (!inDegree.get(id)) queue.push(c) }) }
  nodes.filter(n => inDegree.get(n.id)>0).forEach(n => { n.level=1 }); return nodes
}
function flowData(raw) {
  const nodes = levels(safeArray(raw.nodes).filter(n => n && n.id).map(n => ({ id:n.id, title:clean(n.title)||'Untitled fact', author:clean(n.author)||'unknown', preview:clean(n.statement_preview), revoked:!!n.revoked, predecessors:safeArray(n.predecessors), children:safeArray(n.children) })))
  const perLevel = new Map(); nodes.forEach(n => { if (!perLevel.has(n.level)) perLevel.set(n.level,[]); perLevel.get(n.level).push(n) })
  const visualNodes = []; [...perLevel.keys()].sort((a,b)=>a-b).forEach(level => { const layer=perLevel.get(level); layer.sort((a,b)=>a.id.localeCompare(b.id)); const span=Math.max(900, layer.length*290); layer.forEach((n,i) => visualNodes.push({ id:n.id, type:'fact', position:{ x:i*290-span/2, y:level*250 }, data:n })) })
  const known=new Set(nodes.map(n=>n.id)); const edges=nodes.flatMap(n => n.predecessors.filter(p=>known.has(p)).map(p => ({ id:`${p}-${n.id}`, source:p, target:n.id, type:'smoothstep', animated:false, className:n.revoked?'edge-revoked':'', markerEnd:{type:'arrowclosed'} })))
  return { nodes:visualNodes, edges, facts:nodes, factDetails:raw.facts&&typeof raw.facts==='object'?raw.facts:{}, stats:raw.stats||{}, project:clean(raw.problem_id)||'Fact Graph' }
}
function FactNode({ data, selected }) {
  const k=kind(data)
  return <div className={`fact-node ${k} ${selected?'selected':''}`}><Handle type="target" position={Position.Top} className="port"/><div className="node-cap"><span className="node-state">{data.revoked?'REVOKED':'VERIFIED'}</span><span className="node-level">L{data.level}</span></div><strong>{clip(data.title,54)}</strong><p>{clip(data.preview||data.title,90)}</p><footer><code>{data.id.slice(0,8)}</code><span>← {data.predecessors.length} · {data.children.length} →</span></footer><Handle type="source" position={Position.Bottom} className="port"/></div>
}
const nodeTypes={fact:FactNode}
function Inspector({ node, facts, isStatic, onClose, onJump }) {
  const [copyState,setCopyState]=useState(''),[liveDetail,setLiveDetail]=useState(null),[detailError,setDetailError]=useState('')
  if (!node) return null
  useEffect(()=>{if(!node||isStatic){setLiveDetail(null);setDetailError('');return}setLiveDetail(null);setDetailError('');fetch('/api/fact/'+encodeURIComponent(node.id),{cache:'no-store'}).then(r=>r.ok?r.json():Promise.reject(new Error('HTTP '+r.status))).then(r=>setLiveDetail(r.fact)).catch(e=>setDetailError(e.message))},[node,isStatic])
  const detail=isStatic?facts[node.id]:liveDetail; const refs=safeArray(detail?.external_refs); const glossary=detail?.glossary&&typeof detail.glossary==='object'?detail.glossary:{}
  const glossaryText=Object.entries(glossary).map(([k,v])=>`${k}: ${v}`).join('\n')
  const contentText=`id:${node.id}\nGlossary：${glossaryText}\nStatement：${detail?.statement||''}\nProof：${detail?.proof||''}`
  const fullText=JSON.stringify({id:node.id,title:node.title,author:node.author,statement_preview:node.preview,revoked:node.revoked,status:node.revoked?'REVOKED':'VERIFIED',type:kind(node).toUpperCase(),level:node.level,predecessors:node.predecessors,children:node.children,detail},null,2)
  const copyBundle=async type=>{if(!detail)return;try{await writeClipboard(type==='full'?fullText:contentText);setCopyState(type);setTimeout(()=>setCopyState(''),1200)}catch{setCopyState('')}}
  return <aside className="inspector"><header><div><small>FACT INSPECTOR · {isStatic?'SNAPSHOT':'LIVE'}</small><h2>{node.title}</h2></div><button onClick={onClose}>×</button></header><div className="pills"><b className={node.revoked?'bad':'ok'}>{node.revoked?'REVOKED':'VERIFIED'}</b><b>{kind(node).toUpperCase()}</b></div><div className="copy-actions"><button type="button" disabled={!detail} onClick={()=>copyBundle('content')}>{copyState==='content'?'已复制':'单内容复制'}</button><button type="button" disabled={!detail} onClick={()=>copyBundle('full')}>{copyState==='full'?'已复制':'完整复制'}</button></div><code className="fact-id">{node.id}</code><div className="meta"><span>作者<b>{node.author}</b></span><span>前置<b>{node.predecessors.length}</b></span><span>后续<b>{node.children.length}</b></span></div><section><h3>前置依赖</h3>{node.predecessors.length?node.predecessors.map(id=><button className="relation" key={id} onClick={()=>onJump(id)}>{id}</button>):<i>无</i>}</section><section><h3>后续节点</h3>{node.children.length?node.children.map(id=><button className="relation" key={id} onClick={()=>onJump(id)}>{id}</button>):<i>无</i>}</section>{detailError?<p className="error">详情加载失败：{detailError}</p>:!detail?<p className="muted">{isStatic?'快照未包含该节点详情。':'加载实时详情…'}</p>:<><Details title="Statement" value={detail.statement} open copyable/><Details title="Proof" value={detail.proof} copyable/><Details title="Glossary" value={glossaryText} copyable/><Details title="References" value={refs.map(x=>typeof x==='string'?x:JSON.stringify(x)).join('\n')}/></>}</aside>
}
function Details({title,value,open,copyable=false}) {
  const [copied,setCopied]=useState(false)
  const copy=async e=>{e.preventDefault();e.stopPropagation();try{await writeClipboard(value);setCopied(true);setTimeout(()=>setCopied(false),1200)}catch{setCopied(false)}}
  return value?<details open={open}><summary><span>{title}</span>{copyable&&<button className="copy-detail" type="button" onClick={copy} aria-label={`复制 ${title}`}>{copied?'已复制':'复制'}</button>}</summary><pre>{value}</pre></details>:null
}
function LevelNavigator({level,max,onChange}) {
  if(max<1)return null
  const move=delta=>onChange(Math.max(0,Math.min(max,level+delta)))
  const wheel=e=>{e.preventDefault();e.stopPropagation();move(e.deltaY>0?1:-1)}
  return <Panel position="top-right" className="level-nav" onWheel={wheel}><b>L{level}</b><button type="button" onClick={()=>onChange(0)} title="跳到第一层">L0</button><input type="range" min="0" max={max} value={level} onChange={e=>onChange(Number(e.target.value))} aria-label={`当前层级 ${level}，共 ${max+1} 层`}/><button type="button" onClick={()=>onChange(max)} title="跳到最后一层">L{max}</button></Panel>
}
function Canvas() {
  const [graph,setGraph]=useState(null),[selected,setSelected]=useState(null),[error,setError]=useState(''),[flowReady,setFlowReady]=useState(false),[activeLevel,setActiveLevel]=useState(0); const canvasRef=useRef(null); const { fitView, setCenter, getZoom }=useReactFlow()
  const isStatic=!import.meta.env.DEV
  const load=useCallback(async()=>{try{setError('');const url=isStatic?`${import.meta.env.BASE_URL}fact-graph.json`:'/api/graph';const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw Error(isStatic?'未找到静态快照':'无法读取本地 Fact Graph API');setGraph(flowData(await r.json()))}catch(e){setError(e.message)}},[isStatic])
  const maxLevel=useMemo(()=>graph?Math.max(0,...graph.facts.map(n=>n.level)):0,[graph])
  useEffect(()=>{load()},[load]); useEffect(()=>{if(graph&&flowReady){const timer=setTimeout(()=>fitView({padding:.12,duration:450,maxZoom:.72}),80);return()=>clearTimeout(timer)}},[graph,flowReady,fitView])
  useEffect(()=>setActiveLevel(level=>Math.min(level,maxLevel)),[maxLevel])
  const jump=useCallback(id=>{const n=graph?.nodes.find(n=>n.id===id);if(n)setSelected(n.data)},[graph])
  const goLevel=useCallback(level=>{if(!graph)return;const next=Math.max(0,Math.min(maxLevel,level));const layer=graph.nodes.filter(n=>n.data.level===next);const x=layer.reduce((sum,n)=>sum+n.position.x+121,0)/Math.max(1,layer.length);setActiveLevel(next);setCenter(x,next*250+70,{zoom:getZoom()})},[graph,maxLevel,getZoom,setCenter])
  const syncLevel=useCallback((_,viewport)=>{const height=canvasRef.current?.clientHeight;if(!height)return;const centerY=(height/2-viewport.y)/viewport.zoom;setActiveLevel(Math.max(0,Math.min(maxLevel,Math.round((centerY-70)/250))))},[maxLevel])
  useEffect(()=>{if(!selected||!graph)return;const n=graph.nodes.find(n=>n.id===selected.id);if(!n)return;const frame=requestAnimationFrame(()=>setCenter(n.position.x+120,n.position.y+70,{zoom:.86,duration:350}));return()=>cancelAnimationFrame(frame)},[selected,graph,setCenter])
  if(error)return <div className="fatal"><h2>无法读取 Fact Graph</h2><p>{error}</p><button onClick={load}>重试</button></div>
  if(!graph)return <div className="loading">读取 Danus fact graph…</div>
  return <div className="shell"><header className="bar"><div className="brand"><i></i><b>Fact Graph</b><span>{graph.project}</span></div><div className="search">只读 Dify 风格工作流画布 · {isStatic?'静态快照':'实时本地数据'}</div><button onClick={load}>重新载入</button></header><main className="workspace"><Inspector node={selected} facts={graph.factDetails} isStatic={isStatic} onClose={()=>setSelected(null)} onJump={jump}/><div className="canvas" ref={canvasRef}><ReactFlow nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} fitView fitViewOptions={{padding:.12,maxZoom:.72}} onInit={()=>setFlowReady(true)} onMoveEnd={syncLevel} nodesDraggable={false} onNodeClick={(_,n)=>jump(n.id)} proOptions={{hideAttribution:true}}><Background gap={16} size={1} color="#dfe6ee"/><Controls showInteractive={false}/><MiniMap nodeColor={n=>n.data?.revoked?'#d95563':!n.data?.predecessors?.length?'#21a66c':'#526cff'} nodeStrokeColor="#ffffff" nodeStrokeWidth={5} nodeBorderRadius={8} bgColor="#ffffff" maskColor="rgba(82,108,255,.10)" maskStrokeColor="#526cff" maskStrokeWidth={2} zoomable pannable/><LevelNavigator level={activeLevel} max={maxLevel} onChange={goLevel}/><Panel position="top-left" className="overview"><b>{graph.facts.length}</b><span>已验证事实</span><b>{graph.edges.length}</b><span>依赖边</span></Panel></ReactFlow></div></main></div>
}
createRoot(document.getElementById('root')).render(<ReactFlowProvider><Canvas/></ReactFlowProvider>)
