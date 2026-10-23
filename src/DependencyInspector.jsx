import { useState } from 'react'
import { edgeKindLabel, statusInfo } from './graph-data.js'

const asArray = value => Array.isArray(value) ? value : []
function safeUrl(value) {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null
  } catch { return null }
}

function Evidence({ entries }) {
  const seen = new Set()
  const links = asArray(entries).flatMap(entry => {
    const url = safeUrl(entry?.url)
    if (!url || seen.has(url)) return []
    seen.add(url)
    return [{ ...entry, url }]
  })
  return links.length ? <ul className="references">{links.map(entry => <li key={entry.url}><a href={entry.url} target="_blank" rel="noopener noreferrer">{entry.label || entry.path || '查看来源依据 ↗'}</a></li>)}</ul> : null
}

function Relations({ edges, upstream, byId, onJump }) {
  if (!edges.length) return <p className="muted">{upstream ? '此快照未列出前置关系；不代表没有数学假设。' : '此快照未列出后续交付物。'}</p>
  return edges.map((edge, index) => {
    const id = upstream ? edge.from : edge.to
    const other = byId.get(id)
    const status = statusInfo(other)
    return <div className={'relation-row edge-' + edge.kind} key={edge.from + '-' + edge.to + '-' + edge.kind + '-' + index}>
      <button className="relation" onClick={() => onJump(id)}>{other?.title || id}</button>
      <div className="relation-kind"><span>{edgeKindLabel(edge.kind)}</span><span className={'status-' + status.key}>{status.label}</span></div>
      <p>{edge.reason}</p>
      {edge.kind === 'alternative' && <p className="snapshot-caveat">这是替代路线，不表示必须与其他路线同时满足。</p>}
      {edge.directImport === false && <p className="snapshot-caveat">传递项目依赖闭包的前置；不是该目标的直接 import，也不是新增数学假设。</p>}
      <Evidence entries={edge.evidence}/>
    </div>
  })
}

export default function DependencyInspector({ node, graph, onClose, onJump, writeClipboard }) {
  const [copyState, setCopyState] = useState('')
  if (!node) return null
  const detail = graph.factDetails[node.id]
  const status = statusInfo(node)
  const byId = new Map(graph.facts.map(fact => [fact.id, fact]))
  const incoming = asArray(detail?.incoming)
  const outgoing = asArray(detail?.outgoing)
  const criteria = asArray(detail?.criteria)
  const evidence = [...asArray(detail?.evidence), ...asArray(detail?.links)]
  const content = [
    node.title, 'ID: ' + node.id, '状态: ' + status.label,
    detail?.description,
    detail?.activityDetail || detail?.activity,
    criteria.length ? '完成标准：\n' + criteria.map(value => '• ' + value).join('\n') : '',
    incoming.length ? '前置关系：\n' + incoming.map(edge => edge.from + ' → ' + edge.to + ' [' + edgeKindLabel(edge.kind) + '] ' + edge.reason).join('\n') : '',
  ].filter(Boolean).join('\n\n')
  const full = JSON.stringify({ id: node.id, status: node.status, source: graph.source, detail }, null, 2)
  const copy = async type => {
    try {
      await writeClipboard(type === 'full' ? full : content)
      setCopyState(type)
      setTimeout(() => setCopyState(''), 1200)
    } catch { setCopyState('failed') }
  }
  const metadata = {
    ...(detail?.admissionEvidence ? { admissionEvidence: detail.admissionEvidence } : {}),
    ...(detail?.sourceEvidence ? { sourceEvidence: detail.sourceEvidence } : {}),
    ...(detail?.parentReferenceOnly ? { parentReferenceOnly: true } : {}),
  }
  return <aside className="inspector">
    <header><div><small>PROOF DEPENDENCY · SNAPSHOT</small><h2>{node.title}</h2></div><button onClick={onClose} aria-label="关闭节点详情">×</button></header>
    <div className="pills"><b className={'status-' + status.key}>{status.label}</b><b>关键交付物 · L{node.level}</b></div>
    <div className="copy-actions"><button type="button" onClick={() => copy('content')}>{copyState === 'content' ? '已复制' : '单内容复制'}</button><button type="button" onClick={() => copy('full')}>{copyState === 'full' ? '已复制' : '完整复制'}</button></div>
    {copyState === 'failed' && <p className="error" role="status">复制失败，请重试。</p>}
    <code className="fact-id">{node.id}</code>
    <p>{detail?.description}</p>
    {node.status === 'green' && <p className="snapshot-caveat">局部交付物已在所列前提下核验；下游仍需满足各自的完整前提。</p>}
    <section><h3>当前工作与验收状态</h3><p>{detail?.activityDetail || detail?.activity || '此快照未补充工作说明。'}</p></section>
    {criteria.length > 0 && <section><h3>完成标准</h3><ul>{criteria.map((value, index) => <li key={index}>{value}</li>)}</ul></section>}
    <section><h3>记录的前置关系 · {incoming.length}</h3><Relations edges={incoming} upstream byId={byId} onJump={onJump}/></section>
    <section><h3>完成后支撑 · {outgoing.length}</h3><Relations edges={outgoing} byId={byId} onJump={onJump}/></section>
    {evidence.length > 0 && <section><h3>节点依据</h3><Evidence entries={evidence}/></section>}
    {detail?.note && <p className="snapshot-caveat">{detail.note}</p>}
    {Object.keys(metadata).length > 0 && <details><summary>来源与验收元数据</summary><pre>{JSON.stringify(metadata, null, 2)}</pre></details>}
  </aside>
}
