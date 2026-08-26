# Danus Fact Graph Pages

静态 GitHub Pages 查看器：React Flow 读取仓库中的 `public/fact-graph.json`，不需要 Node API、数据库或运行时服务。

## 本地查看

```bash
npm ci
npm run dev
```

## 更新图谱快照

该仓库只保存可审计的静态快照。需要在原始 Danus 工作区执行：

```bash
cd fact-graph-viewer/dify-ui
npm run snapshot
```

随后提交 `public/fact-graph.json` 并推送到 `main`；GitHub Actions 会自动构建并部署 Pages。

`fact-graph.json` 包含完整事实陈述、证明与术语，因此公开 Pages 会公开这些内容。部署前请确认仓库与 Pages 可见性符合预期。
