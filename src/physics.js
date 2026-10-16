/* GFI.Physics — 力导向模拟 */
(function (GFI) {
  'use strict';
  if (GFI.Physics) return;
  const { clamp } = GFI.util;
  const PIN_NONE = 0;
  const PIN_HARD = 1;

  function create(D, cfg) {
    const n = D.n;
    const { x, y, vx, vy, ax, ay, deg, charge, simWeight, pinMode, fx, fy } = D;

    // 斥力大格，碰撞小格
    const chargeGrid = GFI.Spatial.create(cfg.distanceMax / 2);
    const collideGrid = GFI.Spatial.create(cfg.collideCell);
    const activeMask = new Uint8Array(n);

    // 碰撞搜索半径
    let maxNodeR = 0;
    for (let i = 0; i < n; i++) if (D.radius[i] > maxNodeR) maxNodeR = D.radius[i];

    // 孤立节点的固定角向槽位
    const isoSlot = new Int32Array(n).fill(-1);
    let isoCount = -1;

    const sim = {
      alpha: 1,
      alphaTarget: 0,
      alphaMin: cfg.alphaMin,
      alphaDecay: 1 - Math.pow(cfg.alphaMin, 1 / Math.max(1, cfg.settleTicks)),
      tickCount: 0,
      asleep: false,   // 是否停止
      grid: chargeGrid,   // 斥力网格
      collideGrid,       // 碰撞网格
      activeMask,       // 活跃节点数组
      lod: 1,           // 性能挡位
      chargeSkip: 0,    // 斥力计数器
    };

    function zeroForces() {
      ax.fill(0, 0, n);
      ay.fill(0, 0, n);
    }

    // 活跃节点更新
    function updateActiveMask() {
      let active = 0;
      for (let i = 0; i < n; i++) {
        const a = simWeight[i] > 0 ? 1 : 0;
        activeMask[i] = a;
        active += a;
      }
      return active;
    }

    // 引脚
    function applyPins() {
      for (let i = 0; i < n; i++) {
        if (pinMode[i] === PIN_HARD) {
          x[i] = fx[i]; y[i] = fy[i];
          vx[i] = 0; vy[i] = 0;
          ax[i] = 0; ay[i] = 0;
        }
      }
    }


    let dragBoostNode = -1;
    let dragBoostFactor = 1;
    const dragBoostBlend = new Float32Array(n);

    // 弹簧力
    function forceLink(a) {
      const { m, lsrc, ltgt, ldist, lstr, lvisible } = D;
      const boosting = dragBoostNode >= 0;

      // hub-hub 边加强
      const hubThreshold = cfg.hubLinkThreshold || 5;
      const hubLinkBoost = cfg.hubLinkBoost || 1;

      for (let e = 0; e < m; e++) {
        if (!lvisible[e]) continue;
        const s = lsrc[e], t = ltgt[e];
        const ws = simWeight[s], wt = simWeight[t];
        if (ws === 0 || wt === 0) continue;
        if (pinMode[s] === PIN_HARD && pinMode[t] === PIN_HARD) continue;

        const dx = x[t] - x[s], dy = y[t] - y[s];
        const d2 = dx * dx + dy * dy;
        if (d2 === 0) continue;
        const d = Math.sqrt(d2);

        const ds = deg[s], dt = deg[t];
        const sum = ds + dt;
        const biasT = sum > 0 ? ds / sum : 0.5;
        const biasS = 1 - biasT;

        let be = 1;
        if (boosting && (s === dragBoostNode || t === dragBoostNode)) {
          be = dragBoostFactor;
        } else if (hubLinkBoost > 1 && ds >= hubThreshold && dt >= hubThreshold) {
          be = hubLinkBoost;
        }

        const l = (d - ldist[e]) / d * a * lstr[e] * be * ws * wt;

        if (pinMode[s] !== PIN_HARD) { vx[s] += dx * l * biasS; vy[s] += dy * l * biasS; }
        if (pinMode[t] !== PIN_HARD) { vx[t] -= dx * l * biasT; vy[t] -= dy * l * biasT; }
      }
    }

    // 库仑力
    function forceManyBody(a, skipIsolated) {
      const R = cfg.distanceMax;
      // 斥力截断半径
      const R2 = R * R;
      // 距离比这个小的时候按这个算斥力
      const minD = cfg.distanceMin;
      const ld = cfg.linkDistance;
      const falloff = cfg.chargeFalloff | 0;

      // 空间网格
      const cols = chargeGrid.cols, rows = chargeGrid.rows;
      if (!cols || !rows) return;

      const cellStart = chargeGrid.cellStart, items = chargeGrid.items;
      const inv = chargeGrid.inv, gMinX = chargeGrid.minX, gMinY = chargeGrid.minY;

      for (let i = 0; i < n; i++) {
        if (!activeMask[i]) continue;
        const isoI = deg[i] === 0;

        const xi = x[i], yi = y[i];
        const swi = simWeight[i];

        // i 的实际电荷
        const ci = Math.abs(charge[i]) * swi;

        // 算节点 i 周围R范围内的格子范围
        let cx0 = ((xi - R - gMinX) * inv) | 0;
        let cy0 = ((yi - R - gMinY) * inv) | 0;
        let cx1 = ((xi + R - gMinX) * inv) | 0;
        let cy1 = ((yi + R - gMinY) * inv) | 0;
        if (cx0 < 0) cx0 = 0;
        if (cy0 < 0) cy0 = 0;
        if (cx1 >= cols) cx1 = cols - 1;
        if (cy1 >= rows) cy1 = rows - 1;
        if (cx0 > cx1 || cy0 > cy1) continue;

        // 累加斥力
        let axi = 0, ayi = 0;

        // 三层循环
        for (let cy = cy0; cy <= cy1; cy++) {
          const rowBase = cy * cols;
          for (let cx = cx0; cx <= cx1; cx++) {
            const c = rowBase + cx;
            const end = cellStart[c + 1];
            for (let p = cellStart[c]; p < end; p++) {
              const j = items[p];
              if (j <= i) continue;
              if (!activeMask[j]) continue;
              // 跨组
              if (skipIsolated && (deg[j] === 0) !== isoI) continue;
              const dx = x[j] - xi, dy = y[j] - yi;
              const d2 = dx * dx + dy * dy;
              if (d2 > R2 || d2 < 1e-12) continue;

              const d = Math.sqrt(d2);
              const dd = d < minD ? minD : d;

              // 平均电荷
              const swj = simWeight[j];
              const cj = Math.abs(charge[j]) * swj;
              const cAvg = Math.min(ci, cj);

              let mag;
              if (falloff === 0) {
                // // 恒定幅值
                mag = cAvg * a;
              } else if (falloff === 2) {
                // K/d²
                mag = cAvg * ld * ld * a / (dd * dd);
              } else {
                // // K/d
                mag = cAvg * ld * a / dd;
              }

              // 计算加速度
              const ux = dx / d, uy = dy / d;
              axi -= ux * mag;
              ayi -= uy * mag;
              if (pinMode[j] !== PIN_HARD) {
                ax[j] += ux * mag;
                ay[j] += uy * mag;
              }
            }
          }
        }

        // 被固定的节点不参与积分
        if (pinMode[i] !== PIN_HARD) { ax[i] += axi; ay[i] += ayi; }
      }
    }

    // 向心力计算
    // 所有连通节点拉向质心
    function forceGravity(a) {
      let cxm = 0, cym = 0, k = 0;
      for (let i = 0; i < n; i++) {
        if (!activeMask[i]) continue;
        cxm += x[i]; cym += y[i]; k++;
      }
      if (k === 0) return;
      cxm /= k; cym /= k;

      const dz = cfg.gravityDeadzone;
      const gBase = cfg.gravity * a;
      const gain = cfg.gravityDegGain;

      for (let i = 0; i < n; i++) {
        if (!activeMask[i] || pinMode[i] === PIN_HARD) continue;
        if (deg[i] === 0) continue;

        const degFactor = gain > 0
          ? Math.min(1, gain * (1 + Math.sqrt(deg[i])))
          : 1;
        const g = gBase * degFactor;

        const dx = x[i] - cxm, dy = y[i] - cym;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d <= dz) continue;
        // 等价 -(dx/d) * g 和 -(dy/d) * g
        // 这里做了算法优化
        const f = g / d;
        ax[i] -= dx * f;
        ay[i] -= dy * f;
      }
    }

    // 质心刚性回正
    function forceCenter() {
      let sx = 0, sy = 0, k = 0;
      for (let i = 0; i < n; i++) {
        if (!activeMask[i] || pinMode[i] === PIN_HARD) continue;
        sx += x[i]; sy += y[i]; k++;
      }
      if (k === 0) return;
      const shiftX = (sx / k) * cfg.centerStrength;
      const shiftY = (sy / k) * cfg.centerStrength;
      if (shiftX === 0 && shiftY === 0) return;
      for (let i = 0; i < n; i++) { x[i] -= shiftX; y[i] -= shiftY; }
    }

    // 零度节点锚在外圈环上
    function forceIsolatedRing() {
      const rc = cfg.isolatedRing;
      if (!rc || !rc.enabled) return;
      let cx = 0, cy = 0, k = 0, count = 0;
      for (let i = 0; i < n; i++) {
        if (!activeMask[i]) continue;
        if (deg[i] === 0) { count++; continue; }
        cx += x[i]; cy += y[i]; k++;
      }
      if (k === 0) return;
      cx /= k; cy /= k;
      if (count === 0) { isoCount = 0; return; }

      let maxR = cfg.linkDistance * 0.5;

      for (let i = 0; i < n; i++) {
        if (deg[i] === 0 || !activeMask[i]) continue;
        const d = Math.hypot(x[i] - cx, y[i] - cy);
        if (d > maxR) maxR = d;
      }

      const targetR = maxR * rc.factor;
      const pull = rc.strength;

      // 固定角度
      if (count !== isoCount) {
        isoCount = count;
        let k = 0;
        for (let i = 0; i < n; i++) {
          if (deg[i] === 0 && activeMask[i]) isoSlot[i] = k++;
        }
      }

      const step = (Math.PI * 2) / count;

      for (let i = 0; i < n; i++) {
        if (deg[i] !== 0 || !activeMask[i] || pinMode[i] === PIN_HARD) continue;
        const slot = isoSlot[i] < 0 ? 0 : isoSlot[i];

        let dx = x[i] - cx, dy = y[i] - cy;
        let d = Math.hypot(dx, dy);
        if (d < 1e-4) {
          // 正好落在圆心
          const a0 = slot * step;
          dx = Math.cos(a0); dy = Math.sin(a0); d = 1;
        }

        // 径向
        const fr = (targetR - d) / targetR * pull * 2;

        // 角向
        const ang = Math.atan2(dy, dx);
        let diff = slot * step - ang;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;

        const ft = diff * pull * 2;

        const ux = dx / d, uy = dy / d;
        vx[i] += ux * fr - uy * ft;
        vy[i] += uy * fr + ux * ft;
      }
    }

    // 积分
    function integrate(dt, damp) {
      const scale = dt / GFI.DT;
      // 被拖节点的邻居额外加阻尼
      // 阻尼过小时会抖动
      const dm = GFI.config.drag.linkBoostDamp;
      const dampBoosted = (dragBoostNode >= 0 && dm > 0 && dm < 1) ? Math.pow(dm, scale) : damp;
      const dampDelta = dampBoosted - damp;
      for (let i = 0; i < n; i++) {
        if (pinMode[i] === PIN_HARD) continue;
        const di = dampDelta !== 0 ? damp + dampDelta * dragBoostBlend[i] : damp;

        // tick = ms
        vx[i] = (vx[i] + ax[i]) * di;
        vy[i] = (vy[i] + ay[i]) * di;
        x[i] += vx[i] * scale;
        y[i] += vy[i] * scale;

        // 兜底
        if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) {
          x[i] = GFI.util.jitter(i, 7, 400);
          y[i] = GFI.util.jitter(i, 11, 400);
          vx[i] = 0; vy[i] = 0;
        }
      }
    }

    // 防止节点重叠
    function forceCollide(iterations) {
      if (iterations <= 0) return;
      const { radius } = D;
      const cols = collideGrid.cols, rows = collideGrid.rows;
      if (!cols || !rows) return;

      const cellStart = collideGrid.cellStart, items = collideGrid.items;
      const inv = collideGrid.inv, gMinX = collideGrid.minX, gMinY = collideGrid.minY;

      const pad2 = cfg.collidePad * 2;

      for (let it = 0; it < iterations; it++) {
        for (let i = 0; i < n; i++) {
          if (!activeMask[i] || pinMode[i] === PIN_HARD) continue;

          const xi = x[i], yi = y[i], ri = radius[i];

          const maxR = ri + maxNodeR + pad2;
          let cx0 = ((xi - maxR - gMinX) * inv) | 0;
          let cy0 = ((yi - maxR - gMinY) * inv) | 0;
          let cx1 = ((xi + maxR - gMinX) * inv) | 0;
          let cy1 = ((yi + maxR - gMinY) * inv) | 0;
          if (cx0 < 0) cx0 = 0;
          if (cy0 < 0) cy0 = 0;
          if (cx1 >= cols) cx1 = cols - 1;
          if (cy1 >= rows) cy1 = rows - 1;

          for (let cy = cy0; cy <= cy1; cy++) {
            const rowBase = cy * cols;
            for (let cx = cx0; cx <= cx1; cx++) {
              const c = rowBase + cx;
              const end = cellStart[c + 1];
              for (let p = cellStart[c]; p < end; p++) {
                const j = items[p];
                if (j <= i || !activeMask[j]) continue;
                const dx = x[j] - xi, dy = y[j] - yi;

                const d2 = dx * dx + dy * dy;
                const rr = ri + radius[j] + pad2;
                if (d2 >= rr * rr) continue;
                let d, ux, uy;
                if (d2 < 1e-12) {
                  // 用确定性哈希取方向推开 j 
                  const a0 = GFI.util.hash11s(j, 91) * Math.PI * 2;
                  ux = Math.cos(a0); uy = Math.sin(a0);
                  d = 1;                        // overlap = rr-1 ≈ rr
                } else {
                  d = Math.sqrt(d2);
                  ux = dx / d; uy = dy / d;
                }
                const overlap = rr - d;
                const push = overlap * 0.5 * cfg.collideStrength;
                if (pinMode[i] !== PIN_HARD) { x[i] -= ux * push; y[i] -= uy * push; }
                if (pinMode[j] !== PIN_HARD) { x[j] += ux * push; y[j] += uy * push; }
              }
            }
          }
        }
      }
    }

    // 主 tick
    const DT = GFI.DT;

    sim.tick = function tick(dt) {
      dt = dt || DT;

      sim.alpha += (sim.alphaTarget - sim.alpha) * sim.alphaDecay;
      const a = sim.alpha;

      const active = updateActiveMask();
      if (active === 0) { sim.tickCount++; return; }

      const lodCfg = GFI.config.lod.levels[clamp(sim.lod, 0, GFI.config.lod.levels.length - 1) | 0];

      zeroForces();

      applyPins();

      // 算弹簧力
      forceLink(a);


      sim.chargeSkip = (sim.chargeSkip + 1) % Math.max(1, lodCfg.chargeEveryNth);
      if (sim.chargeSkip === 0) {
        chargeGrid.build(D, activeMask);
        forceManyBody(a, cfg.skipIsolatedCharge || lodCfg.skipIsolatedCharge);
      }

      // 将所有节点拉向质心
      forceGravity(a);

      // 孤立节点锚在外圈环上
      forceIsolatedRing();

      // 阻尼
      const damp = Math.pow(cfg.velocityRetain, dt / DT);

      // 用累加的力更新速度和位置
      integrate(dt, damp);

      // 重建碰撞微网格
      if (lodCfg.collideIter > 0) {
        collideGrid.build(D, activeMask);
        forceCollide(lodCfg.collideIter);
      }

      forceCenter();

      sim.tickCount++;
    };


    // 控制 API
    sim.reheat = function reheat(a) {
      if (a > sim.alpha) sim.alpha = a;
      sim.asleep = false;
    };

    // 拖拽期间给被拖节点关联的边临时加刚度，让邻居跟着走
    sim.setDragLinkBoost = function setDragLinkBoost(i, factor) {
      dragBoostNode = (typeof i === 'number' && i >= 0 && i < n) ? i : -1;
      dragBoostFactor = (factor > 0 && Number.isFinite(factor)) ? factor : 1;
      dragBoostBlend.fill(0, 0, n);
      if (dragBoostNode >= 0) {
        const di = deg[dragBoostNode];
        const s = D.adjStart[dragBoostNode], e = D.adjStart[dragBoostNode + 1];
        for (let p = s; p < e; p++) {
          const j = D.adjList[p];
          dragBoostBlend[j] = di / (di + deg[j]);
        }
      }
    };

    sim.setAlphaTarget = function setAlphaTarget(a) { sim.alphaTarget = a; };

    // alpha 回到 alphaMin、速度与受力清零
    sim.reset = function reset() {
      sim.alpha = sim.alphaMin;
      sim.alphaTarget = 0;
      zeroForces();
      vx.fill(0, 0, n);
      vy.fill(0, 0, n);
    };

    sim.pin = function pin(i, px, py) {
      if (i < 0 || i >= n) return;
      pinMode[i] = PIN_HARD;
      fx[i] = px; fy[i] = py;
      x[i] = px; y[i] = py;
      vx[i] = 0; vy[i] = 0;
    };

    sim.unpin = function unpin(i) {
      if (i < 0 || i >= n) return;
      pinMode[i] = PIN_NONE;
    };


    sim.isPinned = function isPinned(i) {
      if (i < 0 || i >= n) return false;
      return pinMode[i] === PIN_HARD;
    };

    sim.isAwake = function isAwake() { return sim.alpha > sim.alphaMin; };

    sim.rebuildGrid = function rebuildGrid() {
      updateActiveMask();
      chargeGrid.build(D, activeMask);
    };

    return sim;
  }

  GFI.Physics = { create, PIN_NONE, PIN_HARD };
})(window.GFI);
