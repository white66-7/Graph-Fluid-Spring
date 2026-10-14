<h1 align="center" >Graph Inertia</h1>


<p align="center">
  <b>A plugin for Logseq graph view</b><br>
  <sub>A force-simulated knowledge graph built on Logseq's local database</sub>
</p>

<p align="center">
  <img alt="hover" src="https://github.com/user-attachments/assets/a285c263-3db7-492b-bdfb-e0fffa5ee084" width="100%" />
</p>

<p align="center">
  <sub><b>Hover</b> — show the name of the hovered node and its neighbors</sub>
</p>

<p align="center">
  <img alt="time travel" src="https://github.com/user-attachments/assets/7c08a7fc-d5e5-4dfd-b370-800647eafdb9" width="100%" />
</p>

<p align="center">
  <b>Time travel</b>
</p>

---

## Features
Graph Inertia takes over graph rendering and replaces it with a **frame-by-frame** force simulation.

---

## Installation

**Logseq Marketplace**: search `Graph Inertia` → Install.

**Manual**: download the zip from [Releases](https://github.com/white66-7/logseq-graph-inertia/releases) → `Settings` → `Plugins` → `Load unpacked plugin`.

**Requirements**: Logseq 0.10+ / 2.x (DB version).

---

## Settings
### Language

| Parameter | Default | Description |
| :--- | :---: | :--- |
| **Language** `language` | `中文` | Panel language. Switches the settings schema and relabels the open panel without reloading the plugin |

### Physics

| Parameter | Default | Description |
| :--- | :---: | :--- |
| **Repulsion** `charge` | `-0.12` | Overall density. Larger absolute value = more spread out |
| **Link Distance** `linkDistance` | `50` | Resting distance between connected nodes. |
| **Velocity Retain** `velocityRetain` | `0.60` | Above 0.90 the layout oscillates |
| **Settle Ticks** `settleTicks` | `400` | How long the graph stays "alive" after opening |

### Drag

| Parameter | Default | Description |
| :--- | :---: | :--- |
| **Neighbour Pull** `linkBoost` | `16` | How strongly neighbors follow a dragged node |
| **Drop Firmness** `releaseAlpha` | `0.05` | Layout activity after release |

### Time Travel

| Parameter | Default | Description |
| :--- | :---: | :--- |
| **Timelapse Rate** `timelapseRate` | `slow` | Node reveal speed |

### Labels

| Parameter | Default | Description |
| :--- | :---: | :--- |
| **Label Density** `labelMaxRatio` | `1.0` | Fraction of nodes eligible to show a name; 1 = all |
| **Journal Labels** `labelJournal` | `false` | Show name labels on journal nodes |
| **Hide Overlapping Labels** `labelYield` | `false` | Off: allow overlap; On: overlapping labels yield to each other |
| **Node Size** `nodeSize` | `1.0` | Scale of node dots |

### Rendering Performance

| Parameter | Default | Description |
| :--- | :---: | :--- |
| **Prewarm Layout in Background** `prewarm` | `true` | After the plugin loads, settle the force simulation in the background so the graph is already in its final form on first paint |
| **Sync Settle Budget** `syncSettleMs` | `300` | Time budget (ms) to finish settling behind the loading indicator when prewarm is unfinished |
| **Reveal Fade-in** `revealAnimMs` | `320` | Fade-in duration when the graph appears from behind the loading indicator; 0 = instant |

### Data Filtering

| Parameter | Default | Description |
| :--- | :---: | :--- |
| **Custom Excluded Classes** `hideClassIdents` | `Journal / Page / Code / Tag / ...` | By default hides meaningless hub nodes such as Code, Page, Journal. Delete a name to show it; add names to hide more |
| **Custom Excluded Names** `hideNames` | `card / Property / Comment / ...` | Filter zero-degree nodes by name. Content pages with links are not affected |

---

## How It Works

```
Pixi/Canvas native graph  ──(takeover)──►  custom Canvas2D
                                              │
        ┌─────────────────────────────────────┼─────────────────────────────────────┐
        ▼                                     ▼                                     ▼
   Logseq DB fetch                     frame-by-frame force sim                timeline filter
   (pages/links/createdAt)                    │                                   │
                                              │                                   │
                                              │                                   │
                                              └──────────► render ◄─────────────────┘
```

**Technical highlights**:

- **Hand-written force engine**: springs, truncated repulsion, collision, centripetal gravity, isolated-node outer ring anchoring
- **Unified spatial grid**: reused for repulsion cutoff, collision detection, mouse hit testing, and viewport culling
- **Fixed-length array storage**: hot-loop data uses SoA + TypedArray
- **Time travel**: rank-based progression + per-frame reveal budget

---

## Development

**Debug probes**:

```js
__GFI__.diag()          // automatic fault detection
__GFI__.dump()          // layout distribution
__GFI__.calibrate()     // current graph's p50 link length and per-stage timings
__GFI__.tlState()       // timeline state
__GFI__.native(true)    // switch back to native graph
```

---

## License

[MIT License](./LICENSE) © 2026 white66-7
