# Riemann Semantic Zoom Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Unfold the RH overview through three source-grounded graph granularities while zooming.
**Architecture:** A source expansion asset supplies declaration nodes/edges by reveal tier; pure helpers build deterministic tier graphs and preserve viewport anchors; a dedicated React Flow component integrates zoom controls and existing inspectors.
**Tech Stack:** React 19, React Flow 12, Vite 7, Python extraction, Node assertions.
**Spec:** docs/superpowers/specs/2026-11-23-riemann-semantic-zoom-design.md

## Global Constraints
- Preserve the original 42 overview nodes and 38 edges, and all Goldbach/Danus data.
- Pin source to 7cbf7a0c32fca1badf05931879a37c3f8a2b03b4.
- Expanded edges are resolved source references, not kernel proof-term dependencies.
- Tier thresholds: entering 0.50 / 1.05; returning 0.36 / 0.82.
- No graph-wide fit on tier change or measured node size updates.

## Review Focus
- Continuous wheel zoom crosses both thresholds without flicker or undoing zoom.
- Collapsing a selected fine node retains a meaningful overview owner.
- Delayed/failed data requests leave the overview usable and do not affect another dataset.
- Shared declarations keep stable identities and all displayed edges have endpoints.
- Fixed node geometry, visible-element rendering and deterministic clusters remain navigable at fine tier.

## Task 1 — Source-grounded expansion data
- [x] Write and run focused extraction tests before implementation.
- [x] Extract direct references from the 42 seeds and one further source-reference level, retaining precise source evidence and unresolved boundaries.
- [x] Write public/riemann-expansion.json and validate all generated evidence against pinned source.

## Task 2 — Pure zoom and graph model
- [x] Test thresholds, hysteresis, nested identities, real reference edges, duplicate handling, collapse ownership and screen-anchor invariance.
- [x] Implement src/semantic-zoom.js and scripts/check-semantic-zoom.mjs.
- [x] Produce deterministic three-tier layouts and existing inspector-compatible graph records.

## Task 3 — Canvas integration
- [x] Add src/SemanticProofCanvas.jsx and CSS; wire loading, wheel transitions, tier controls, source detail and current expansion boundaries.
- [x] Integrate with main.jsx while preserving the legacy canvases and the module browser.
- [x] Update guide/README and run graph checks plus production build.

## Task 4 — Review and publish
- [x] Independent code/data review, correct material findings and verify regressions.
- [x] Commit to existing project using a non-forced update with expected head.
- [ ] Confirm Pages deployment at that commit and inspect real wheel-driven transitions online.
