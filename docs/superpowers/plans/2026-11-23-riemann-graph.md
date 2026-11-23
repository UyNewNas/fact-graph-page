# Riemann Fact Graph Implementation Plan

> **For agentic workers:** Use executing-plans for integration and focused parallel agents for independent extraction and review. Checkboxes track the concrete deliverables.

**Goal:** Publish a source-grounded RH / Dirichlet GRH fact graph with full module lookup on the existing GitHub Pages site.

**Architecture:** Keep the current static React Flow application. Add a generic proof snapshot adapter and a lazy full-module explorer. Generate metadata from a pinned upstream checkout, with separate curated mathematical explanations and attributed verification evidence.

**Tech Stack:** React 19, React Flow 12, Vite 7, Node's native test runner, Python 3 for source extraction, GitHub Actions / Pages.

**Spec:** `docs/superpowers/specs/2026-11-23-riemann-graph-design.md`

## Global constraints

- Source revision: `7cbf7a0c32fca1badf05931879a37c3f8a2b03b4`.
- No Lean compilation; static graph validation is not proof verification.
- Keep `public/goldbach-graph.json`, `public/goldbach-details.json`, and `public/fact-graph.json` unchanged.
- Use fixed-commit upstream source URLs and identify module edges as imports.
- Do not reproduce the upstream Lean code wholesale in this repository.

## Review focus

- Source status must never appear as local kernel verification.
- Empty, ambiguous, or very broad module searches must remain usable.
- Project-subpath asset URLs and query links must survive deployment.
- Raw metadata and evidence must survive graph conversion and copy/export.
- A truncated neighborhood must expose total counts and access to all dependencies.

## Task 1 — Source data and extraction

- [x] Confirm source snapshot, root statements, and third-party verification provenance.
- [x] Add deterministic full-module extractor, compact index, and dependency chunks.
- [x] Add curated mathematical spine with declaration identifiers, source evidence, and exact edge semantics.
- [x] Validate module references, coverage, hashes, main roots, and curated DAG.

## Task 2 — Viewer integration

- [x] Add a failing adapter test for `proof-dependencies-v1` and the independent `source` status.
- [x] Generalize project/source/legend text while preserving legacy schemas.
- [x] Add statement, declaration, reasoning and evidence sections to the inspector.
- [x] Add `riemann` dataset, readable overview/evidence panel, and lazy module lookup with focused dependency navigation.
- [ ] Run all data regressions and production build; smoke-test desktop and mobile.

## Task 3 — Review and publish

- [x] Review diff and provenance with a fresh agent, address material findings.
- [x] Record accurate source coverage and validation scope in README.
- [ ] Commit and publish through the existing authorized GitHub Pages workflow.
- [ ] Verify deployed commit and live `?graph=riemann` route; report concrete links and scope.

## Execution notes

- Existing baseline passed: Goldbach 86/108 and Danus 734/2398.
- Work is in a fresh checkout on `feat/riemann-fact-graph-20261123`.
- User requested the existing repository and GitHub Pages; implementation and publication are within that task.

- Extraction outcome: 175,187 modules, 753,261 internal imports, 136,503 external imports; independent source pass matched every file.
- Transfer decision: retain identical JSON as gzip assets (54,686,272 → 13,026,474 bytes); hashes for both forms are in the manifest.
- Review fixes: preserve source-directory prefix and raw provenance; state complete pole/window/input conditions; show report scopes; isolate the fallback overlay from inline loading. Path/provenance regressions were observed failing and then passing.
- Production build and static checks pass. Local browser launch is restricted by this executor; final interaction checks use the published site.
- Publication uses the connected GitHub API because this checkout has no Git push credential. All content stays in the requested public repository.
