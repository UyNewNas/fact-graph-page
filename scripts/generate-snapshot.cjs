#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { scan, FACT_GRAPH_DIR } = require('../../server.js');

const data = scan();
const nodes = data.nodes.map((n) => ({
  id: n.id,
  title: n.title || '',
  statement_preview: (n.statement || '').split('\n').filter(Boolean).slice(1).join(' ').slice(0, 180) || n.title || '',
  author: n.author || '',
  problem_id: n.problem_id || '',
  revoked: Boolean(n.revoked),
  predecessors: Array.isArray(n.predecessors) ? n.predecessors : [],
  children: Array.isArray(n.children) ? n.children : [],
}));

const facts = Object.fromEntries(data.nodes.map((n) => [n.id, {
  ...n,
  predecessors: Array.isArray(n.predecessors) ? n.predecessors : [],
  children: Array.isArray(n.children) ? n.children : [],
  external_refs: Array.isArray(n.external_refs) ? n.external_refs : [],
  arxiv_ids: Array.isArray(n.arxiv_ids) ? n.arxiv_ids : [],
  glossary: n.glossary && typeof n.glossary === 'object' ? n.glossary : {},
}]));
const payload = {
  version: 1,
  generated_at: new Date().toISOString(),
  fact_graph_dir: FACT_GRAPH_DIR,
  problem_id: data.nodes.find((n) => n.problem_id)?.problem_id || '',
  stats: data.stats,
  nodes,
  facts,
};
const out = path.join(__dirname, '..', 'public', 'fact-graph.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(payload));
console.log(`snapshot: ${nodes.length} nodes → ${out}`);
