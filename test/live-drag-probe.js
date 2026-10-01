/*
 * GFI — 拖拽抖动【实机】探针（贴进 DevTools 控制台用，不是 node 脚本）
 * ===========================================================================
 * 为什么需要它：headless 沙箱只加载 8 个不碰 DOM 的模块，
 * 【加载不了 interaction.js 与 main.js】—— 而拖拽链路和主循环恰恰在那里。
 * 无头探针已经否掉了两个假设（linkBoost 弹簧过冲、forceCenter 与 pins 打架），
 * 再往下必须有实机数据，否则就是脑补。
 *
 * ── 用法 ──────────────────────────────────────────────────────────────────
 * 1. 在【Logseq 主窗口】按 Ctrl+Shift+I 打开 DevTools（不是插件 iframe 的控制台）
 * 2. 把 A 段整个粘进 Console，回车 → 显示「已布防」
 * 3. 切回图谱，**拖一个节点并制造你说的抽搐**，松手
 * 4. 报告会自动打印。把打印内容整段发我
 *
 * ── 判读 ──────────────────────────────────────────────────────────────────
 * · 被拖节点偏离 pin 目标 > 2wu      → pin 不变式被破坏（有东西在移动被钉的节点）
 * · 邻居「折返」总数 很大             → 邻居真的在来回弹 = 抽搐
 * · 邻居速度 远大于指针速度          → 邻居在乱窜（不是弹，但视觉上也像抽）
 * · 每帧 substep 分布 出现 0          → 帧率与物理步长错拍（会一顿一顿）
 */

// ===========================================================================
// A 段：布防 + 自动报告
// ===========================================================================
(() => {
  const api = window.__GFI__ && window.__GFI__.graph;
  if (!api) {
    console.warn('[jit] 找不到 window.__GFI__.graph —— 请在 Logseq 【主窗口】的 DevTools 里运行，不是插件 iframe');
    return;
  }
  const D = api.D, sim = api.sim;

  const S = {
    active: false, frames: 0, ticks: {}, dragNode: -1,
    pinErrMax: 0, pinErrSum: 0,
    nbrSpeedMax: 0, nbrSpeedSum: 0, nbrSpeedN: 0,
    reversalTotal: 0, reversalMax: 0,
    alphaMin: Infinity, alphaMax: 0,
    dispMax: 0,
  };

  const prevX = new Float64Array(D.n), prevY = new Float64Array(D.n);
  const prevVX = new Float64Array(D.n), prevVY = new Float64Array(D.n);
  const has = new Uint8Array(D.n);
  let lastTick = sim.tickCount;
  let lastPX = 0, lastPY = 0;

  function frame() {
    requestAnimationFrame(frame);
    const inter = api.inter;
    const i = inter ? inter.dragNode : -1;

    if (i >= 0 && !S.active) { S.active = true; S.dragNode = i; has.fill(0); }
    if (i < 0 && S.active) { S.active = false; report(); return; }
    if (!S.active) return;

    S.frames++;
    const t = sim.tickCount - lastTick; lastTick = sim.tickCount;
    S.ticks[t] = (S.ticks[t] || 0) + 1;
    if (sim.alpha < S.alphaMin) S.alphaMin = sim.alpha;
    if (sim.alpha > S.alphaMax) S.alphaMax = sim.alpha;

    // ---- 指针的世界坐标（从 pin 目标反推，因为 fx/fy 就是它）----
    const pxx = D.fx[i], pyy = D.fy[i];

    // ---- ① 被拖节点：渲染位置 vs 它自己的 pin 目标 ----
    const err = Math.hypot(D.x[i] - pxx, D.y[i] - pyy);
    S.pinErrSum += err;
    if (err > S.pinErrMax) S.pinErrMax = err;

    // 指针本帧移动了多少（世界单位）
    const ptrStep = Math.hypot(pxx - lastPX, pyy - lastPY);
    lastPX = pxx; lastPY = pyy;

    // ---- ② 所有节点：单帧位移 + 速度方向折返 ----
    for (let j = 0; j < D.n; j++) {
      if (!D.visible[j]) continue;
      if (has[j]) {
        const dx = D.x[j] - prevX[j], dy = D.y[j] - prevY[j];
        const disp = Math.hypot(dx, dy);
        if (j !== i && disp > S.dispMax) S.dispMax = disp;

        const vx = D.vx[j], vy = D.vy[j];
        const pvx = prevVX[j], pvy = prevVY[j];
        const sp = Math.hypot(vx, vy), psp = Math.hypot(pvx, pvy);
        if (psp > 1e-4 && sp > 1e-4) {
          const cos = (pvx * vx + pvy * vy) / (psp * sp);
          if (cos < -0.5) S.reversalTotal++;          // 方向反转 > 120° = 折返
        }
        // 邻居统计（只统计被拖节点的直接邻居）
        if (j !== i) {
          S.nbrSpeedSum += sp; S.nbrSpeedN++;
          if (sp > S.nbrSpeedMax) S.nbrSpeedMax = sp;
        }
      }
      prevX[j] = D.x[j]; prevY[j] = D.y[j];
      prevVX[j] = D.vx[j]; prevVY[j] = D.vy[j];
      has[j] = 1;
    }
    void ptrStep;
  }

  function report() {
    const f = Math.max(1, S.frames);
    const i = S.dragNode;
    console.log('%c[jit] 拖拽实机报告', 'font-weight:bold;font-size:13px');
    console.log('  帧数', S.frames, ' 每帧 substep 分布', S.ticks);
    console.log('  ① 被拖节点偏离 pin 目标：最大', S.pinErrMax.toFixed(2), 'wu  平均', (S.pinErrSum / f).toFixed(2), 'wu');
    console.log('  ② 邻居速度：最大', S.nbrSpeedMax.toFixed(2), 'wu/tick  平均', (S.nbrSpeedSum / Math.max(1, S.nbrSpeedN)).toFixed(2));
    console.log('  ③ 全图方向折返（>120°）总数', S.reversalTotal, ' 单帧峰值', S.reversalMax);
    console.log('  ④ 非拖拽节点的单帧最大位移', S.dispMax.toFixed(2), 'wu');
    console.log('  ⑤ 度数', D.deg[i], ' 邻居数', D.adjStart[i + 1] - D.adjStart[i]);
    console.log('  ⑥ alpha', S.alphaMin.toExponential(3), '~', S.alphaMax.toFixed(4), ' awake', sim.isAwake(), ' LOD', sim.lod);
    console.log('  ⑦ linkBoost =', (window.GFI && GFI.config) ? GFI.config.drag.linkBoost : '(插件窗口内，主窗口读不到)');
  }

  requestAnimationFrame(frame);
  console.log('%c[jit] 已布防 —— 现在去拖一个节点，松手后自动出报告', 'color:#4c9;font-weight:bold');
})();

// ===========================================================================
// B 段：一键 A/B 对照 —— 不改文件、不重载，直接判定凶手
//
// 复制下面【一行】到主窗口 Console 回车，然后去拖一次：
//
//   · 关掉局部弹簧增益（倍率强制 = 1）：
//     (()=>{const s=__GFI__.graph.sim,o=s.setDragLinkBoost;s.setDragLinkBoost=(i,f)=>o(i,f>1?1:f);console.log('[jit] 增益已关闭，拖一次看还抽不抽');})()
//
//   · 改成别的倍率（把 8 换成 1 / 4 / 8 / 16 / 24 逐个试手感）：
//     (()=>{const s=__GFI__.graph.sim,o=s.setDragLinkBoost;s.setDragLinkBoost=(i,f)=>o(i,f>1?8:f);console.log('[jit] 倍率 = 8');})()
//
// 判读：
//   关掉后抽搐消失  → 凶手是这个局部弹簧增益，我把机制换掉（不是简单调小）
//   关掉后照样抽搐  → 与它无关，是别的东西；此时请跑 A 段，用数据定位
//
// 重载插件即恢复（这只是覆盖了内存里的函数，没改文件）。
// ===========================================================================
