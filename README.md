<h1 align="center">Graph Inertia</h1>

<p align="center">
  <b>Logseq 图谱的物理引擎</b><br>
  <sub>A living, force-simulated knowledge graph for Logseq.</sub>
</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/1f50289d-a763-47e3-9bb7-6f3cbed7728a" alt="悬停：只显示相连节点的名字" width="100%" />
</p>

<p align="center">
  <sub><b>悬停</b> — 只显示该节点与相邻节点名称</sub>
</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/d369151c-da4d-4961-bd44-da6623d4035c" alt="时间旅行：节点随波前逐个生长" width="100%" />
</p>

<p align="center">
  <sub><b>时间旅行</b> — 节点逐个过冲后收回</sub>
</p>

---

## 为什么需要它
摆脱静态感
```clojure
_ (.stop simulation)
ticks (layout-tick-count (count nodes) view-mode)]
(dotimes [_ ticks] (.tick simulation))
```

`.stop` 之后力导向模拟被丢弃
由此带来：
- **拖不动**
- **时间旅行表现为透明度切换。** 

Graph Inertia 接管图谱渲染，换成**逐帧运行**的力导向模拟。

---

## 安装

**Logseq Marketplace**：搜索 `Graph Inertia` → Install。

**手动**：从 [Releases](https://github.com/white66-7/logseq-graph-inertia/releases) 下载 zip → `设置` → `插件` → `Load unpacked plugin`。

**要求**：Logseq 0.10+ / 2.x（DB 版）
---

## 设置

| 设置 | 默认 | 说明 |
| :--- | :---: | :--- |
| **使用原生图谱** | 关 | 回退到 Logseq 内置图谱 |
| **斥力强度** | `-0.10` | 整体疏密。绝对值越大越舒展 |
| **连接线长度** | `82` | 决定看起来是"图谱"还是"毛球" |
| **速度保留率** | `0.80` | 最敏感的一项。超过 0.90 布局会振荡 |
| **活跃时长** | `400` | 打开图谱后它"活"多久（帧） |
| **甩掷惯性** | `1.4` | 快速甩出节点时的惯性倍率 |
| **松手回弹** | `0.76` | 越低回弹越明显（≈2.5% 过冲） |
| **节点弹出幅度** | `0.55` | 新节点过冲幅度（≈33%） |
| **弹出阻尼比** | `0.35` | 越低越"弹" |
| **时间波强度** | `210` | 设为 0 可完全关闭 |
| **演变周期** | `45` | 播放一遍需要多少秒 |
| **标签密度** | `0.3` | 常态下标注多少比例的节点 |

### ⚠ 改参数前请先读这段

`斥力强度` 和 `速度保留率` 是**实测**出来。它们的关系非线性 —— 每个节点在其斥力半径内通常有几十个邻居，贡献同向叠加。

改动幅度建议控制在 ±50% 以内。大幅调整，请借助仓库的标定工具：

```bash
node test/quick-cal.js 200 300    # 二分搜索出合适的斥力强度
node test/headless-sim.js         # 56 项回归测试
```

## 它是怎么工作的

```
Pixi/Canvas 原生图谱  ──(接管)──►  自绘 Canvas2D
                                      │
        ┌─────────────────────────────┼─────────────────────────────┐
        ▼                             ▼                             ▼
   Logseq DB 取数              逐帧力导向模拟                 时间轴过滤
   (页面/链接/创建时间)       (连边弹簧·截断斥力·           (createdAt <= cutoff)
                              碰撞·向心重力)                        │
                                      │                             │
                                      └──────────► 渲染 ◄───────────┘
```

**技术要点**：
- **手写模拟器**，不依赖 d3-force。
- **统一空间网格**：斥力截断、碰撞检测、鼠标命中、视口剔除四处复用。
- **定长数组存储**（SoA），整个生命周期零分配 —— 这对 60fps 至关重要。
---

## 开发

```bash
node test/headless-sim.js     # 56 项：数据层 / 物理 / 网格 / 激波 / 时间轴 / 交互
node test/quick-cal.js        # 参数标定
node test/repro-blowup.js     # 布局发散时的诊断
```

物理、网格、数据、特效四个模块**完全不碰 DOM**，所以能在 Node 里直接测，不需要启动 Logseq —— 这让大多数回归都能在秒级发现。

**调试探针**（重新加载插件后，在主窗口控制台执行）：

```js
__GFI__.diag()          // 渲染/挂载/相机的完整状态 + 自动故障判定
__GFI__.dump()          // 布局分布：包围盒、离质心距离、度数直方图、全部节点清单
__GFI__.calibrate()     // 当前图谱的 p50 边长与各阶段耗时
__GFI__.tlState()       // 时间轴状态
__GFI__.native(true)    // 切回原生图谱
```
---

## 致谢

图谱视觉参考了 [Obsidian](https://obsidian.md) 的图谱；力导向参数区间部分参考了 Logseq 自身 `frontend.extensions.graph.pixi.logic` 的实现。

## License

[MIT](./LICENSE) © 2026 white66-7
