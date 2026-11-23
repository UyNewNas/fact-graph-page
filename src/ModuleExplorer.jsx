import { useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react'
import './module-explorer.css'
import { normalizeModuleQuery, sourceModulePath, sourceModuleUrl } from './module-paths.js'

const DATA_ROOT = import.meta.env.BASE_URL + 'riemann-modules/'
const SEARCH_LIMIT = 30
const PAGE_SIZE = 50
const NEIGHBOR_LIMIT = 10
const MAX_CACHED_CHUNKS = 24
let cachedIndex = null
const cachedChunks = new Map()
const formatCount = value => Number(value || 0).toLocaleString('zh-CN')

// Count the complete index, but retain only a bounded result set for the DOM.
function searchModuleNames(names, value, limit = SEARCH_LIMIT) {
  const query = normalizeModuleQuery(value)
  if (!query) return { query, total: 0, matches: [] }
  const exact = [], prefix = [], other = []
  let total = 0
  names.forEach((name, id) => {
    const folded = name.toLowerCase()
    if (!folded.includes(query)) return
    total++
    const bucket = folded === query ? exact : folded.startsWith(query) ? prefix : other
    if (bucket.length < limit) bucket.push({ id, name })
  })
  return { query, total, matches: [...exact, ...prefix, ...other].slice(0, limit) }
}

function pageWindow(total, requestedPage) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const page = Math.max(0, Math.min(requestedPage, pages - 1))
  const start = page * PAGE_SIZE
  return { page, pages, start, end: Math.min(total, start + PAGE_SIZE) }
}

async function fetchJson(filename, signal) {
  const response = await fetch(DATA_ROOT + filename, { signal })
  if (!response.ok) throw new Error(`无法读取模块索引 ${filename}（HTTP ${response.status}）`)
  const compressed = filename.endsWith('.gz')
  if (compressed && typeof DecompressionStream !== 'function') {
    throw new Error('当前浏览器不支持模块索引的 gzip 解压。请使用支持 DecompressionStream 的新版浏览器。')
  }
  try {
    const decoded = compressed ? new Response(response.body.pipeThrough(new DecompressionStream('gzip'))) : response
    return await decoded.json()
  }
  catch (error) {
    if (signal.aborted) throw error
    throw new Error(`模块索引 ${filename} 不是有效的 JSON 数据。`)
  }
}

async function loadIndex(signal) {
  if (cachedIndex) return cachedIndex
  const manifest = await fetchJson('manifest.json', signal)
  const counts = ['moduleCount', 'internalEdgeCount', 'externalEdgeCount', 'totalLines']
  if (manifest?.schema !== 'lean-module-index-v1' || manifest.chunkSize !== 512
    || manifest.sourceDirectory !== 'src'
    || !['names.json', 'names.json.gz'].includes(manifest.namesFile)
    || !['chunks/{chunk}.json', 'chunks/{chunk}.json.gz'].includes(manifest.chunkPattern)
    || !/^[\w.-]+\/[\w.-]+$/.test(manifest.sourceRepository || '')
    || !/^[a-f0-9]{40}$/i.test(manifest.sourceCommit || '')
    || counts.some(key => !Number.isSafeInteger(manifest[key]) || manifest[key] < 0)) {
    throw new Error('模块索引清单格式不正确，请重新载入或检查发布的数据。')
  }
  const names = await fetchJson(manifest.namesFile, signal)
  if (!Array.isArray(names) || names.length !== manifest.moduleCount
    || names.some(name => typeof name !== 'string' || !name)) {
    throw new Error('模块名称索引与清单不一致，请重新载入。')
  }
  const index = { manifest, names }
  if (!signal.aborted) cachedIndex = index
  return index
}

function validModuleEntry(entry, moduleCount) {
  const validId = value => Number.isSafeInteger(value) && value >= 0 && value < moduleCount
  const validLine = value => Number.isSafeInteger(value) && value > 0 && value <= entry.lines
  return entry && Number.isSafeInteger(entry.lines) && entry.lines >= 0
    && /^[a-f0-9]{64}$/i.test(entry.sha256 || '')
    && Array.isArray(entry.imports) && entry.imports.every(item => Array.isArray(item) && validId(item[0]) && validLine(item[1]))
    && Array.isArray(entry.importedBy) && entry.importedBy.every(validId)
    && Array.isArray(entry.externalImports) && entry.externalImports.every(item => Array.isArray(item) && typeof item[0] === 'string' && item[0] && validLine(item[1]))
}

async function loadModule(index, id, signal) {
  const { manifest } = index
  const chunkNumber = Math.floor(id / manifest.chunkSize)
  const key = manifest.sourceCommit + ':' + chunkNumber
  let chunk = cachedChunks.get(key)
  if (!chunk) chunk = await fetchJson(manifest.chunkPattern.replace('{chunk}', String(chunkNumber)), signal)
  const entry = Array.isArray(chunk) ? chunk[id % manifest.chunkSize] : null
  if (!validModuleEntry(entry, manifest.moduleCount)) {
    cachedChunks.delete(key)
    throw new Error('这个模块的关系数据不完整或格式不正确，请重试。')
  }
  if (!signal.aborted) {
    cachedChunks.delete(key)
    cachedChunks.set(key, chunk)
    while (cachedChunks.size > MAX_CACHED_CHUNKS) cachedChunks.delete(cachedChunks.keys().next().value)
  }
  return entry
}

function Pagination({ total, page, onPage, label }) {
  const range = pageWindow(total, page)
  const [draft, setDraft] = useState(String(range.page + 1))
  const [error, setError] = useState('')
  const inputId = useId()
  useEffect(() => { setDraft(String(range.page + 1)); setError('') }, [range.page])
  if (range.pages <= 1) return null
  const go = event => {
    event.preventDefault()
    const next = Number(draft)
    if (!Number.isInteger(next) || next < 1 || next > range.pages) {
      setError(`请输入 1 至 ${formatCount(range.pages)} 之间的页码。`)
      return
    }
    setError('')
    onPage(next - 1)
  }
  return <nav className="module-pagination" aria-label={label + '分页'}>
    <div className="module-page-buttons">
      <button type="button" onClick={() => onPage(range.page - 1)} disabled={range.page === 0} aria-label={label + '上一页'}>上一页</button>
      <span>第 {formatCount(range.page + 1)} / {formatCount(range.pages)} 页</span>
      <button type="button" onClick={() => onPage(range.page + 1)} disabled={range.page + 1 === range.pages} aria-label={label + '下一页'}>下一页</button>
    </div>
    <form onSubmit={go} noValidate>
      <label htmlFor={inputId}>跳至</label>
      <input id={inputId} type="number" inputMode="numeric" min="1" max={range.pages} value={draft} onChange={event => { setDraft(event.target.value); setError('') }} aria-label={label + '页码'} aria-invalid={!!error}/>
      <button type="submit">前往</button>
    </form>
    {error && <p className="module-error-text" role="alert">{error}</p>}
  </nav>
}

function ModuleRelations({ kind, entries, names, sourceUrl, onNavigate }) {
  const [page, setPage] = useState(0)
  const headingId = useId()
  const range = pageWindow(entries.length, page)
  const title = kind === 'imports' ? '本模块直接 import 的内部模块' : kind === 'importedBy' ? '直接 import 本模块的内部模块' : '外部 import'
  return <section className={'module-relation-section module-relations-' + kind} aria-labelledby={headingId}>
    <div className="module-section-heading"><h3 id={headingId}>{title}</h3><span className="module-count">{formatCount(entries.length)}</span></div>
    {kind === 'external' && <p className="module-muted">Mathlib 等外部依赖单独列出；行号链接定位当前文件的 import 语句。</p>}
    {entries.length ? <>
      <p className="module-range" aria-live="polite">显示 {formatCount(range.start + 1)}–{formatCount(range.end)} 项，共 {formatCount(entries.length)} 项</p>
      <ul className="module-relation-list">
        {entries.slice(range.start, range.end).map((item, offset) => {
          const targetId = kind === 'importedBy' ? item : item[0]
          const name = kind === 'external' ? item[0] : names[targetId]
          const line = kind === 'importedBy' ? null : item[1]
          const content = <><span className="module-row-number" aria-hidden="true">{formatCount(range.start + offset + 1)}</span><code>{name}</code></>
          return <li key={`${targetId}-${line || 0}-${offset}`}>
            {kind === 'external'
              ? <div className="module-external-label">{content}<span className="module-external-tag">{name === 'Mathlib' || name.startsWith('Mathlib.') ? 'Mathlib' : '外部'}</span></div>
              : <button type="button" className="module-relation-button" onClick={() => onNavigate(name)} title={name}>{content}<span aria-hidden="true">→</span></button>}
            {line && <a className="module-line-link" href={sourceUrl + '#L' + line} target="_blank" rel="noopener noreferrer" aria-label={`${name} 的 import 语句，当前源码第 ${line} 行`}>L{line} ↗</a>}
          </li>
        })}
      </ul>
      <Pagination total={entries.length} page={range.page} onPage={setPage} label={title}/>
    </> : <p className="module-empty">{kind === 'importedBy' ? '此索引中没有模块直接 import 当前文件。' : kind === 'external' ? '当前文件未记录外部 import。' : '当前文件未记录内部 import。'}</p>}
  </section>
}

function Neighborhood({ name, entry, names, onNavigate }) {
  const headingId = useId()
  const branches = [
    { label: '它直接 import 的内部模块', ids: entry.imports.slice(0, NEIGHBOR_LIMIT).map(item => item[0]), total: entry.imports.length, side: 'before' },
    { label: '直接 import 它的内部模块', ids: entry.importedBy.slice(0, NEIGHBOR_LIMIT), total: entry.importedBy.length, side: 'after' },
  ]
  const branch = value => <div className={'module-neighbor-branch module-neighbor-' + value.side}>
    <h4>{value.label}</h4>
    <span className="module-neighbor-count">展示 {value.ids.length} / {formatCount(value.total)}</span>
    <div className="module-neighbor-buttons">{value.ids.map((id, position) => <button type="button" key={id + '-' + position} onClick={() => onNavigate(names[id])} title={names[id]}><code>{names[id]}</code></button>)}</div>
    {!value.ids.length && <p className="module-empty">无此类关系</p>}
  </div>
  return <section className="module-neighborhood-section" aria-labelledby={headingId}>
    <div className="module-section-heading"><h3 id={headingId}>当前模块的局部邻域</h3><span className="module-mini-label">最多 21 个模块</span></div>
    <p className="module-muted">箭头从被 import 的文件指向使用它的文件。每侧最多展示前 10 项；全部关系均可在下方列表翻页查看。</p>
    <div className="module-neighborhood" role="group" aria-label="当前模块的有限源码邻域">
      {branch(branches[0])}<span className="module-neighborhood-arrow" aria-hidden="true">→</span>
      <div className="module-neighbor-current"><span>当前文件</span><strong>{name}</strong><small>{formatCount(entry.lines)} 行源码</small></div>
      <span className="module-neighborhood-arrow" aria-hidden="true">→</span>{branch(branches[1])}
    </div>
  </section>
}

export default function ModuleExplorer({ initialModule = 'Main', onClose }) {
  const id = useId()
  const dialogRef = useRef(null)
  const searchRef = useRef(null)
  const resultsRef = useRef(null)
  const bodyRef = useRef(null)
  const headingRef = useRef(null)
  const focusModuleRef = useRef(false)
  const [index, setIndex] = useState(null)
  const [indexError, setIndexError] = useState('')
  const [indexRetry, setIndexRetry] = useState(0)
  const [moduleRetry, setModuleRetry] = useState(0)
  const [navigation, setNavigation] = useState(() => ({ names: [initialModule || 'Main'], position: 0 }))
  const currentName = navigation.names[navigation.position]
  const [moduleState, setModuleState] = useState({ name: '', entry: null, error: '' })
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const search = useMemo(() => searchModuleNames(index?.names || [], deferredQuery), [index, deferredQuery])
  const currentId = useMemo(() => index?.names.indexOf(currentName) ?? -1, [index, currentName])
  const entry = moduleState.name === currentName ? moduleState.entry : null
  const moduleError = moduleState.name === currentName ? moduleState.error : ''
  const sourceUrl = index && currentId >= 0 ? sourceModuleUrl(index.manifest, currentName) : null
  const close = useCallback(() => { dialogRef.current?.close(); onClose?.() }, [onClose])

  useEffect(() => {
    const previousFocus = document.activeElement
    const dialog = dialogRef.current
    dialog.showModal()
    searchRef.current?.focus()
    return () => {
      if (dialog.open) dialog.close()
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [])

  useEffect(() => {
    setNavigation({ names: [initialModule || 'Main'], position: 0 })
  }, [initialModule])

  useEffect(() => {
    const controller = new AbortController()
    setIndexError('')
    loadIndex(controller.signal)
      .then(value => { if (!controller.signal.aborted) setIndex(value) })
      .catch(error => { if (!controller.signal.aborted) setIndexError(error.message || '模块索引载入失败。') })
    return () => controller.abort()
  }, [indexRetry])

  useEffect(() => {
    if (!index) return
    const controller = new AbortController()
    setModuleState({ name: currentName, entry: null, error: '' })
    if (currentId < 0) {
      setModuleState({ name: currentName, entry: null, error: '索引未收录这个模块名称。请通过上方搜索选择模块。' })
    } else {
      loadModule(index, currentId, controller.signal)
        .then(value => { if (!controller.signal.aborted) setModuleState({ name: currentName, entry: value, error: '' }) })
        .catch(error => { if (!controller.signal.aborted) setModuleState({ name: currentName, entry: null, error: error.message || '模块关系载入失败。' }) })
    }
    return () => controller.abort()
  }, [index, currentId, currentName, moduleRetry])

  const focusCurrent = useCallback(() => {
    bodyRef.current?.scrollTo({ top: 0 })
    headingRef.current?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    if (focusModuleRef.current) { focusCurrent(); focusModuleRef.current = false }
  }, [currentName, focusCurrent])

  const navigate = useCallback(name => {
    if (name === currentName) { focusCurrent(); return }
    focusModuleRef.current = true
    setNavigation(current => ({ names: [...current.names.slice(0, current.position + 1), name], position: current.position + 1 }))
  }, [currentName, focusCurrent])
  const moveHistory = delta => {
    focusModuleRef.current = true
    setNavigation(current => ({ ...current, position: Math.max(0, Math.min(current.names.length - 1, current.position + delta)) }))
  }
  const submitSearch = event => {
    event.preventDefault()
    if (!index) return
    const latest = searchModuleNames(index.names, query)
    if (latest.matches[0] && (latest.total === 1 || latest.matches[0].name.toLowerCase() === latest.query)) navigate(latest.matches[0].name)
    else resultsRef.current?.querySelector('button')?.focus()
  }
  const closeBackdrop = event => {
    if (event.target !== dialogRef.current) return
    const bounds = event.currentTarget.getBoundingClientRect()
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close()
  }

  return <dialog ref={dialogRef} className="module-explorer" aria-labelledby={id + '-title'} aria-describedby={id + '-semantics'} onCancel={event => { event.preventDefault(); close() }} onClick={closeBackdrop}>
    <header className="module-explorer-header">
      <div className="module-explorer-title"><p>RH / DIRICHLET GRH · SOURCE MODULES</p><h2 id={id + '-title'}>全量源码模块浏览器</h2><span className="module-current-chip" title={currentName}>当前：{currentName}</span>
        {index && <p className="module-index-totals">{formatCount(index.manifest.moduleCount)} 个模块 · {formatCount(index.manifest.internalEdgeCount)} 条内部 import · {formatCount(index.manifest.externalEdgeCount)} 条外部 import · {formatCount(index.manifest.totalLines)} 行</p>}
      </div>
      <button type="button" className="module-close" onClick={close} aria-label="关闭模块浏览器">关闭 <span aria-hidden="true">×</span></button>
    </header>
    <div className="module-search-panel">
      <p className="module-semantics" id={id + '-semantics'}>这里记录模块之间的 import 关系，不是证明项依赖闭包。源码存在和文件哈希不表示证明已通过 Lean 核验。</p>
      <form className="module-search-form" role="search" onSubmit={submitSearch}>
        <label htmlFor={id + '-search'}>搜索模块名称</label>
        <div className="module-search-field"><input ref={searchRef} id={id + '-search'} type="search" value={query} autoComplete="off" spellCheck="false" onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'ArrowDown' && search.matches.length) { event.preventDefault(); resultsRef.current?.querySelector('button')?.focus() } }} placeholder="例如 Main、Riemann 或模块路径" aria-describedby={id + '-search-hint'}/><button type="submit" disabled={!index}>定位</button></div>
        <span className="module-search-hint" id={id + '-search-hint'}>不区分大小写；支持 .lean 路径。精确匹配优先，按 Enter 定位或按 ↓ 选择结果。</span>
      </form>
      {index && query.trim() && <div className="module-search-results" aria-busy={query !== deferredQuery}>
        <p className="module-result-summary" role="status">{query !== deferredQuery ? '正在更新搜索…' : search.total ? `共 ${formatCount(search.total)} 个匹配，显示 ${search.matches.length} 个${search.total > search.matches.length ? '；请补充模块名缩小范围。' : '。'}` : '没有匹配模块。请检查名称，或尝试较短的模块路径。'}</p>
        {search.matches.length > 0 && <ul ref={resultsRef} aria-label="模块搜索结果">{search.matches.map(result => <li key={result.id}><button type="button" onClick={() => navigate(result.name)} aria-current={result.name === currentName ? 'true' : undefined}><code>{result.name}</code>{result.name.toLowerCase() === search.query && <span>精确匹配</span>}</button></li>)}</ul>}
      </div>}
    </div>
    <div className="module-explorer-body" ref={bodyRef}>
      {!index ? indexError ? <div className="module-error" role="alert"><h3>模块索引读取失败</h3><p>{indexError}</p><button type="button" onClick={() => setIndexRetry(value => value + 1)}>重试载入索引</button></div> : <p className="module-loading" role="status">正在载入全量模块名称索引…</p> : <>
        <nav className="module-navigation" aria-label="模块浏览历史"><div><button type="button" onClick={() => moveHistory(-1)} disabled={navigation.position === 0}>← 上个模块</button><button type="button" onClick={() => moveHistory(1)} disabled={navigation.position === navigation.names.length - 1}>下个模块 →</button></div><a href={`https://github.com/${index.manifest.sourceRepository}/commit/${index.manifest.sourceCommit}`} target="_blank" rel="noopener noreferrer">固定源码版本 {index.manifest.sourceCommit.slice(0, 8)} ↗</a></nav>
        <section className="module-current-section" aria-labelledby={id + '-current'}>
          <span className="module-mini-label">当前文件 · 源码关系</span><h3 id={id + '-current'} ref={headingRef} tabIndex={-1}>{currentName}</h3>
          {sourceUrl && <a className="module-source-link" href={sourceUrl} target="_blank" rel="noopener noreferrer">查看固定版本源码 · {sourceModulePath(index.manifest, currentName)} ↗</a>}
          {entry ? <dl className="module-file-metadata"><div><dt>源码行数</dt><dd>{formatCount(entry.lines)}</dd></div><div><dt>SHA-256 · 文件标识</dt><dd><code>{entry.sha256}</code></dd></div></dl> : moduleError ? <div className="module-error" role="alert"><p>{moduleError}</p>{currentId >= 0 && <button type="button" onClick={() => setModuleRetry(value => value + 1)}>重试读取模块</button>}</div> : <p className="module-loading" role="status">正在读取这个模块的直接关系…</p>}
        </section>
        {entry && <>
          <Neighborhood name={currentName} entry={entry} names={index.names} onNavigate={navigate}/>
          <div className="module-relations-grid"><ModuleRelations key={currentName + '-imports'} kind="imports" entries={entry.imports} names={index.names} sourceUrl={sourceUrl} onNavigate={navigate}/><ModuleRelations key={currentName + '-importedBy'} kind="importedBy" entries={entry.importedBy} names={index.names} sourceUrl={sourceUrl} onNavigate={navigate}/></div>
          <ModuleRelations key={currentName + '-external'} kind="external" entries={entry.externalImports} names={index.names} sourceUrl={sourceUrl} onNavigate={navigate}/>
        </>}
      </>}
    </div>
  </dialog>
}
