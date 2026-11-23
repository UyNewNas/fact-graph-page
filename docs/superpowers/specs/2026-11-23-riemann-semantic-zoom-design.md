# Riemann semantic zoom

## Intent
The user wants the existing 42-node RH overview to unfold into finer graphs as the mouse wheel zooms in, using three granularities in the same canvas. They explicitly asked us to try implementing it; routine design choices and deployment to their existing Pages project are authorized by this conversation.

## Design
Use the current React Flow canvas and a three-state semantic zoom controller. Overview retains the exact 42 curated nodes/38 relations. The second tier adds resolvable direct declaration references from those nodes' source. The third adds the next round of declaration references. Both expanded tiers must carry source evidence and explicitly say they are source-reference expansions, not kernel proof-term closure. The module import browser remains a separate auxiliary view.

A declaration present at multiple tiers retains the same ID. Expansion adds real nodes and edges, never placeholder proof steps. Unknown/ambiguous references remain unexpanded and are recorded in extraction coverage. Leaf nodes are labeled as the current expansion boundary rather than mathematical axioms. Full theorem statements must not be invented from a name.

Zoom into tier 1 at 0.50 and tier 2 at 1.05; zoom out from tier 1 below 0.36 and tier 2 below 0.82. These hysteresis bands prevent flapping. Layout may expand around overview clusters; a common node nearest the wheel focus (or viewport center) must keep its screen position across a transition. Never fit the whole graph on a tier change or node measurement. Retain the selected declaration where possible; when it collapses, select its overview owner. Buttons for the three tiers and a return-to-overview action support keyboard/touch and testing.

The current 42-node overview remains immediately available while expansion data loads. Loading failure leaves a usable overview with a retry control. Dataset switches cancel stale loads. Render only visible elements in expanded graphs. Use fixed node dimensions, deterministic layout, and preserve source navigation and inspector behavior.

## Approaches considered
1. Replace the canvas with all 175,187 module imports: wrong relationship and too costly for the requested theorem-level zoom.
2. Draw cosmetic extra nodes: would not represent proof evidence.
3. Selected declaration-reference expansion with three zoom tiers: chosen by the implementer for a concrete usable first version, with honest coverage boundaries.

## Verification
Check genuine source-reference extraction, ambiguous names/comments/strings, stable IDs and tier nesting, graph edge endpoints, threshold hysteresis in both directions, screen-anchor preservation, request failure/staleness, overview restoration, and Goldbach/Danus regression. Build and publish; verify the actual Pages UI with wheel zoom in and out and source-detail navigation.
