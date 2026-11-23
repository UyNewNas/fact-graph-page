export default function ProofOverview({ graph, onJump, onOpenModule, onClose }) {
  const source = graph.source
  const targets = (source.targets || []).map(id => graph.facts.find(node => node.id === id)).filter(Boolean)
  const chapters = source.chapters || []
  const reports = source.verificationReports || []
  return <aside className="inspector proof-guide" aria-label="黎曼证明导读">
    <header><div><small>RIEMANN HYPOTHESIS · PROOF ATLAS</small><h2>沿着事实，读懂证明</h2></div><button onClick={onClose} aria-label="收起证明导读">×</button></header>
    <p className="guide-lead">{source.introduction || '从 Dirichlet L 函数的无零点结论，追溯到窗口估计及其算术输入。每个主线节点都有 Lean 声明与固定版本的源码依据。'}</p>
    <div className="guide-counts"><div><b>{graph.facts.length}</b><span>主线与审查节点</span></div><div><b>{source.moduleCount?.toLocaleString() || '全库'}</b><span>可搜索 Lean 模块</span></div></div>
    <section className="guide-zoom"><h3>用缩放展开证明</h3><p>在画布上滚轮放大，会从 <b>总览</b> 进入 <b>定理引用</b>，再进入 <b>声明细节</b>；缩小时逐层收拢。也可点击画布左上方的三个粒度按钮。</p><p>展开层来自已解析的源码引用，当前边界仍可能有前置。完整的内核证明依赖尚未在这里逐项展开。</p></section>
    <section><h3>从结论回溯</h3>{targets.map(node => <button className="guide-target" key={node.id} onClick={() => onJump(node.id)}><span>{node.title}</span><span aria-hidden="true">→</span></button>)}</section>
    {chapters.length > 0 && <section><h3>阅读路径</h3><ol className="guide-chapters">{chapters.map((chapter, i) => <li key={chapter.id || i}><button onClick={() => onJump(chapter.node || chapter.nodes?.[0])}>{chapter.title}</button><p>{chapter.description}</p></li>)}</ol></section>}
    <button className="explore-modules" onClick={() => onOpenModule('Main')}>搜索全库 Lean 模块 <span>查看导入、被引用及源码 ↗</span></button>
    <p className="guide-attribution">证明：Levent Alpöge 与 Claude<br/>图谱整理：Slava Chan · 镜像：CocoSgt</p>
    <details className="guide-evidence"><summary>来源与外部核验记录</summary><div>
      <p>{source.verificationSummary || '节点标记“源码可追溯”。外部编译与内核检查的适用范围见下列报告；本次图谱生成未运行 Lean。'}</p>
      {reports.map((report, index) => <p key={report.id || index}><a href={report.url} target="_blank" rel="noopener noreferrer">{report.label || report.title || report.name || '核验报告'}</a>{report.summary && <span>{report.summary}</span>}{report.scope && <span>范围：{report.scope}</span>}</p>)}
      {source.provenanceNote && <p>{source.provenanceNote}</p>}
    </div></details>
    <p className="guide-scope">{source.caveat}</p>
    <div className="guide-downloads"><a href={import.meta.env.BASE_URL + 'riemann-graph.json'} download>下载主线 JSON</a><a href={import.meta.env.BASE_URL + 'riemann-modules/manifest.json'} target="_blank" rel="noopener noreferrer">源码索引清单 ↗</a></div>
  </aside>
}
