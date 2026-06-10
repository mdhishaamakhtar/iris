# Product

## Register

product

## Users

Curious people and developers exploring how Wikipedia topics connect. They type two page titles, wait through a live search (seconds to a couple of minutes), then explore the resulting path. Used casually in a browser, desktop and mobile, mostly in dark environments (the UI is dark-first).

## Product Purpose

Iris finds the shortest hyperlink path between two Wikipedia pages using bidirectional BFS over the live Wikipedia link graph, streams search progress in real time, and visualizes the found path as an interactive D3 force graph. Success: the search feels alive while running, and the resulting path is instantly readable and explorable.

## Brand Personality

Technical, precise, calm. A developer-tool aesthetic: GitHub-dark palette, JetBrains Mono everywhere, restrained accent blue (#58A6FF), green for start/success, red for end/danger. The interface should feel like a well-built instrument, not a toy.

## Anti-references

- Neon "cyber" dashboards with glow on everything.
- Generic SaaS gradients and glassmorphism.
- Cartoonish bouncy physics; the graph should settle with confidence, not jiggle.

## Design Principles

1. **Motion conveys search state.** Animation exists to show the algorithm working (frontiers expanding, path found), never as decoration.
2. **The path is the hero.** Once found, the start → end chain must be readable at a glance: direction, order, endpoints.
3. **Earned familiarity.** Standard affordances (drag, click to open, hover tooltips); no invented controls.
4. **Dark-first, token-driven.** All colors flow from the CSS variables in styles.css; D3 reads tokens at render time.

## Accessibility & Inclusion

- Respect `prefers-reduced-motion` for every animation.
- Keyboard access for interactive elements (path steps, currently-exploring link).
- ARIA labels on the SVG graph and live regions for errors.
- Touch: drag must not fight page scroll; 44px minimum touch targets.
