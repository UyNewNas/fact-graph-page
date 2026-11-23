# RH / Dirichlet GRH fact graph

## Intent

Add the Alpöge–Claude RH / Dirichlet GRH development to Slava Chan's existing Fact Graph Pages site. A reader should be able to follow the main mathematical implications, inspect exact Lean declarations and fixed-revision evidence, and search the entire source-module dependency graph without drawing 175,000 nodes at once.

## Design decisions

- Reuse React Flow, the dependency inspector, static JSON, and the existing GitHub Pages workflow. Add `?graph=riemann`; preserve Goldbach and Danus data and the existing default.
- Use `CocoSgt/riemann-hypothesis-lean` at `7cbf7a0c32fca1badf05931879a37c3f8a2b03b4`. Attribute the proof to Levent Alpöge with Claude and identify the repository as a mirror.
- Separate a curated, source-linked mathematical spine from a complete mechanically extracted module-import index. An import edge is a source-file relationship, not a proof-term dependency or a new mathematical assumption.
- Use a distinct `source` status for inspected source declarations. Third-party compile/kernel reports have a separately attributed evidence panel. Do not label this site's static checks as Lean verification. No Lean compilation in this task.
- Keep the full source contents upstream; store source paths, import names, line counts, hashes, a concise original explanatory graph, and links. The mirror states no explicit licence for the original archive.
- Module explorer loads a compact searchable index on demand and renders only a focused neighborhood / paged dependency lists. Record total and displayed counts. Never silently call a truncated view complete.
- Preserve source declarations, mathematical statements, reasoning notes, caveats, references, and edge-specific evidence in copy/export data.

## Approaches considered

1. A hand-written overview only is readable but cannot support full source navigation.
2. Drawing every module simultaneously would be too slow and visually useless.
3. Selected approach: a readable fact graph plus a searchable complete source index and focused neighborhoods. This follows the existing static architecture and supports both reading and auditing.

These are implementation decisions made by the assistant from the user's request to use the existing project and GitHub Pages.

## Success criteria

All existing data regressions pass; new data reject dangling edges, cycles in the curated graph, and invalid source links; import extraction is deterministic and reports coverage. The production build works on a project subpath. The live Pages route loads, can navigate a fact and module, and preserves old datasets.
