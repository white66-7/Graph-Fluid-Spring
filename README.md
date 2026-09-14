<h1 align="center">Graph Fluid Spring</h1>

<p align="center">
  <b>Dual-track momentum physics for Logseq Graph View.</b>
</p>

---

## ✨ Features

* 🛑 **Hard-Brake Viewport**: Dragging the canvas stops immediately upon release (zero sliding, zero drift).
* 🌊 **Fluid Node Momentum**: Flinging nodes triggers smooth momentum with a gentle overshoot ($\zeta \approx 0.48$) before resting stably.
* 🛡️ **Click Safe**: Normal single clicks and page navigation are 100% unaffected.

---

## ⚙️ Configuration

Fine-tune physics parameters in the `CONFIG` object at the top of `index.js`:

| Parameter | Default | Description |
| :--- | :---: | :--- |
| `stiffness` | `0.092` | **Spring Tension**: Higher values snap back faster |
| `damping` | `0.285` | **Friction Loss**: Controls oscillation (higher = less bounce) |
| `overshootMultiplier` | `3.6` | **Throw Distance**: Momentum glide distance multiplier |
| `maxSpeed` | `32.0` | **Speed Cap**: Prevents nodes from flying off-screen |

---

## 📦 Installation

* **Logseq Marketplace**: Search for `Graph Fluid Spring` and click **Install**.
* **Manual**: Download the zip from [Releases](https://github.com/white66-7/Graph-Fluid-Spring/releases) -> `Settings` -> `Plugins` -> `Load unpacked plugin`.

---

## License

[MIT License](./LICENSE) © 2026 white66-7