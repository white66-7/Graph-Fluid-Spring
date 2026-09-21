/*
 * GFI.Physics — 力导向模拟
 * ===========================================================================
 * 积分器：「impulse Verlet」—— 每 tick 只求一次力（当作速度增量，d3 的约定），
 * 配合二阶位置项：
 *     a = F(x)/m
 *     x' = x + v·dt + 0.5·a·dt²
 *     v' = (v + a·dt) · damp
 *
 * 严格的 velocity Verlet 需要每 tick 求两次力（~2× 斥力开销）。在 dt=1/60、
 * damp≈0.94 时两者差异不可观测，不值得。
 *
 * ── 关于 charge 的单位 ──
 * d3-force 的 forceManyBody 是【恒定幅值】斥力（vx += u·strength），不是库仑。
 * 我们用真正的 1/d²。为了让参数保持人类可读且与尺度无关，这里把 charge 定义为：
 *
 *     「在距离 = linkDistance 处的斥力加速度幅值」
 *
 * 即  a(d) = charge · (linkDistance / d)²
 * 等价于 K/d²，只是把 K 换成了一个直观的数。
 */
(function (GFI) {
  'use strict';
  if (GFI.Physics) return;

  const { clamp } = GFI.util;

  const PIN_NONE = 0;
  const PIN_HARD = 1;

  function create(D, cfg) {
    const n = D.n;
    const { x, y, vx, vy, ax, ay, deg, charge, simWeight, pinMode, fx, fy } = D;

    // 网格：斥力用大格，碰撞用小格。
    // 不能共用 —— 节点半径才 2~16，用 210 的格子做碰撞，扫到的格里几乎全是空的。
    const chargeGrid = GFI.Spatial.create(cfg.distanceMax / 2);
    const collideGrid = GFI.Spatial.create(cfg.collideCell);

    // 活动掩码：simWeight > 0 的节点参与一切力
    const activeMask = new Uint8Array(n);

    // 孤立节点的固定角向槽位（见 forceIsolatedRing）
    const isoSlot = new Int32Array(n).fill(-1);
    let isoCount = -1;

    const sim = {
      alpha: 1,
      alphaTarget: 0,
      alphaMin: cfg.alphaMin,
      alphaDecay: 1 - Math.pow(cfg.alphaMin, 1 / Math.max(1, cfg.settleTicks)),
      tickCount: 0,
      asleep: false,
      grid: chargeGrid,          // 命中测试 / 视口剔除复用这个
      collideGrid,
      activeMask,
      lod: 1,
      chargeSkip: 0,             // LOD：隔 tick 跑斥力的计数器
    };

    // d3 的 fx==null 惯用法不能移植到定型数组（读 Float32Array 永远返回数字），
    // 所以用独立的 pinMode 数组显式判断。

    function zeroForces() {
      ax.fill(0, 0, n);
      ay.fill(0, 0, n);
    }

    function updateActiveMask() {
      let active = 0;
      for (let i = 0; i < n; i++) {
        const a = simWeight[i] > 0 ? 1 : 0;
        activeMask[i] = a;
        active += a;
      }
      return active;
    }

    // -----------------------------------------------------------------------
    // 引脚
    // -----------------------------------------------------------------------
    function applyPins() {
      for (let i = 0; i < n; i++) {
        if (pinMode[i] === PIN_HARD) {
          x[i] = fx[i]; y[i] = fy[i];
          vx[i] = 0; vy[i] = 0;
          ax[i] = 0; ay[i] = 0;
        }
      }
    }

    // -----------------------------------------------------------------------
    // forceLink —— 弹簧，按度数分配两端权重
    // -----------------------------------------------------------------------
    function forceLink(a) {
      const { m, lsrc, ltgt, ldist, lstr, lvisible } = D;
      for (let e = 0; e < m; e++) {
        if (!lvisible[e]) continue;
        const s = lsrc[e], t = ltgt[e];
        const ws = simWeight[s], wt = simWeight[t];
        // 正在淡出的节点不能拖拽邻居
        if (ws === 0 || wt === 0) continue;
        if (pinMode[s] === PIN_HARD && pinMode[t] === PIN_HARD) continue;

        const dx = x[t] - x[s], dy = y[t] - y[s];
        const d2 = dx * dx + dy * dy;
        if (d2 === 0) continue;
        const d = Math.sqrt(d2);

        const ds = deg[s], dt = deg[t];
        const sum = ds + dt;
        // 度数低的动得多，hub 几乎不动
        const biasT = sum > 0 ? ds / sum : 0.5;   // 作用在 t 上的权重
        const biasS = 1 - biasT;

        const l = (d - ldist[e]) / d * a * lstr[e] * ws * wt;

        if (pinMode[s] !== PIN_HARD) { vx[s] += dx * l * biasS; vy[s] += dy * l * biasS; }
        if (pinMode[t] !== PIN_HARD) { vx[t] -= dx * l * biasT; vy[t] -= dy * l * biasT; }
      }
    }

    // -----------------------------------------------------------------------
    // forceManyBody —— 网格上的精确截断库仑 1/d²
    // -----------------------------------------------------------------------
    function forceManyBody(a, skipIsolated) {
      const R = cfg.distanceMax;
      const R2 = R * R;
      const minD = cfg.distanceMin;
      const ld = cfg.linkDistance;
      const falloff = cfg.chargeFalloff | 0;
      const cols = chargeGrid.cols, rows = chargeGrid.rows;
      if (!cols || !rows) return;

      const cellStart = chargeGrid.cellStart, items = chargeGrid.items;
      const inv = chargeGrid.inv, gMinX = chargeGrid.minX, gMinY = chargeGrid.minY;

      for (let i = 0; i < n; i++) {
        if (!activeMask[i] || pinMode[i] === PIN_HARD) continue;
        // skipIsolated 的含义是「孤立节点不扰动主干」，而不是「孤立节点之间不作用」。
        // 早先整行跳掉零度节点，导致环上的孤立节点彼此完全不排斥、会叠在一起
        // （实测最小角间隔只有 1.6°）。现在只跳过【跨组】配对。
        const isoI = deg[i] === 0;

        const xi = x[i], yi = y[i];
        const ci = Math.abs(charge[i]);

        // 按节点精确位置算索引区间 —— 不做固定 NxN 扫描，避免 off-by-one 丢力
        let cx0 = ((xi - R - gMinX) * inv) | 0;
        let cy0 = ((yi - R - gMinY) * inv) | 0;
        let cx1 = ((xi + R - gMinX) * inv) | 0;
        let cy1 = ((yi + R - gMinY) * inv) | 0;
        if (cx0 < 0) cx0 = 0;
        if (cy0 < 0) cy0 = 0;
        if (cx1 >= cols) cx1 = cols - 1;
        if (cy1 >= rows) cy1 = rows - 1;
        if (cx0 > cx1 || cy0 > cy1) continue;

        let axi = 0, ayi = 0;

        for (let cy = cy0; cy <= cy1; cy++) {
          const rowBase = cy * cols;
          for (let cx = cx0; cx <= cx1; cx++) {
            const c = rowBase + cx;
            const end = cellStart[c + 1];
            for (let p = cellStart[c]; p < end; p++) {
              const j = items[p];
              if (j <= i) continue;                    // 只算一次，对称施加（避免重复计数）
              if (!activeMask[j]) continue;
              // 跨组（孤立 ↔ 连通）配对跳过
              if (skipIsolated && (deg[j] === 0) !== isoI) continue;
              const dx = x[j] - xi, dy = y[j] - yi;
              const d2 = dx * dx + dy * dy;
              if (d2 > R2 || d2 < 1e-12) continue;

              const d = Math.sqrt(d2);
              const dd = d < minD ? minD : d;

              // 用平均电荷，避免 i、j 电荷不等时失去对称性
              const cj = Math.abs(charge[j]);
              const cAvg = (ci + cj) * 0.5;

              // 三种力律，均匀背景下的净斥力（∫(K/r^p)·2πr·dr）：
              //   p=0 恒定幅值 → 2πKρR²   有限（有 distanceMax 截断时）—— d3 / Logseq 的约定
              //   p=1  K/d     → 2πKρR    有限 —— Fruchterman-Reingold 的 k²/d
              //   p=2  K/d²    → 2πKρ·ln(R/r₀)  【对数发散】二维下图会一路膨胀
              // 三维里 1/r² 的积分是有限的，二维不是 —— 这是二维力导向布局的经典陷阱。
              let mag;
              if (falloff === 0) {
                mag = cAvg * a;                       // 恒定幅值
              } else if (falloff === 2) {
                mag = cAvg * ld * ld * a / (dd * dd); // K/d²
              } else {
                mag = cAvg * ld * a / dd;             // K/d
              }

              // 斥力：i 被推离 j，j 被推离 i（用单位向量，力律只管幅值）
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
        ax[i] += axi;
        ay[i] += ayi;
      }
    }

    // -----------------------------------------------------------------------
    // gravity —— 恒定幅值向心拉力（带死区）
    // 这是真正约束图谱范围、塑造形状的力。
    // 不用 -k·d 的线性弹簧：能把 5000 单位的图拉回来所需的刚度，
    // 会让外围节点的加速度达到几百 wu/s²。
    // -----------------------------------------------------------------------
    function forceGravity(a) {
      let cxm = 0, cym = 0, k = 0;
      for (let i = 0; i < n; i++) {
        if (!activeMask[i]) continue;
        cxm += x[i]; cym += y[i]; k++;
      }
      if (k === 0) return;
      cxm /= k; cym /= k;

      const dz = cfg.gravityDeadzone;
      const g = cfg.gravity * a;
      for (let i = 0; i < n; i++) {
        if (!activeMask[i] || pinMode[i] === PIN_HARD) continue;
        // 孤立节点不吃重力 —— 它们的半径由 isolatedRing 负责。
        // 重力在 alpha 高时是 3/tick，而环力才 0.1/tick，早期完全压不住，
        // 会把孤立节点一路拽进主干里；等 alpha 衰减到环力能赢时，
        // 模拟已经睡着了（alphaMin），它们就永远停在半路上。
        if (deg[i] === 0) continue;
        const dx = x[i] - cxm, dy = y[i] - cym;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d <= dz) continue;
        const f = g / d;
        ax[i] -= dx * f;
        ay[i] -= dy * f;
      }
    }

    // -----------------------------------------------------------------------
    // forceCenter —— 质心刚性回正
    // ⚠ 不乘 alpha：它是整体平移，乘了会在低 alpha 时漂移
    // -----------------------------------------------------------------------
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

    // -----------------------------------------------------------------------
    // forceIsolatedRing —— 把零度节点锚在外圈环上
    //
    // 零度节点没有连边力，只受斥力和微弱重力，位置基本是随机的 ——
    // 结果就是飘在主干中间挡住别的节点。
    //
    // 用【持续拉力】把半径锚定到环上，而不是直接摆位置：
    // 这样它们仍然可拖拽、也能被激波推着走，只是会被缓慢拉回环上。
    // 刻意【不乘 alpha】：乘了的话模拟一沉降，力就消失，它们又飘回去了。
    // -----------------------------------------------------------------------
    function forceIsolatedRing() {
      const rc = cfg.isolatedRing;
      if (!rc || !rc.enabled) return;

      // 连通节点的质心 + 孤立节点计数 —— 一趟扫完。
      //
      // 原来是三趟独立的全表扫描（质心 / 最大半径 / 计数），而"没有任何孤立
      // 节点"是最常见的情况，那时三趟全是白跑：算完的质心和 maxR 直接没人用。
      // 合并之后只剩一趟，而且没有孤立节点时连"最大半径"那一趟都不用做。
      let cx = 0, cy = 0, k = 0, count = 0;
      for (let i = 0; i < n; i++) {
        if (!activeMask[i]) continue;
        if (deg[i] === 0) { count++; continue; }
        cx += x[i]; cy += y[i]; k++;
      }
      if (k === 0) return;                       // 全是孤立节点，没有"外圈"可言
      cx /= k; cy /= k;
      if (count === 0) { isoCount = 0; return; } // 没有孤立节点 —— 后面都不必算

      let maxR = 0;
      for (let i = 0; i < n; i++) {
        if (deg[i] === 0 || !activeMask[i]) continue;
        const d = Math.hypot(x[i] - cx, y[i] - cy);
        if (d > maxR) maxR = d;
      }
      if (maxR < 1) maxR = 1;

      const targetR = maxR * rc.factor;
      const pull = rc.strength;

      // ── 角向槽位 ──
      // ⚠ 槽位必须【固定分配】，绝不能按当前角度反复重排。
      //   曾经每 60 tick 按角度重排一次，造成"目标跟着节点跑"：
      //   节点刚往自己的槽位挪了一点，重排后名次就变了、目标也跟着变，
      //   于是永远在原地打转 —— 实测 12 个节点全挤在 76° 的弧里，
      //   而不是像理想的那样散在整圈。
      //   现在只在【孤立节点数量变化】时重新分配（很少发生）。
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
          // 正好落在圆心 —— 直接按格位角度推出去，避免卡在原地
          const a0 = slot * step;
          dx = Math.cos(a0); dy = Math.sin(a0); d = 1;
        }

        // 径向：把半径拉向 targetR
        const fr = (targetR - d) / targetR * pull * 2;

        // 角向：往自己那个格位靠
        const ang = Math.atan2(dy, dx);
        let diff = slot * step - ang;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        // 切向系数比径向大一些：沉降后期 alpha≈0，孤立节点之间的斥力（乘 alpha）
        // 已经归零，角向分离基本完全靠这个力。
        const ft = diff * pull * 2;

        const ux = dx / d, uy = dy / d;
        vx[i] += ux * fr - uy * ft;              // 径向 + 切向
        vy[i] += uy * fr + ux * ft;
      }
    }

    // -----------------------------------------------------------------------
    // 积分
    // -----------------------------------------------------------------------
    function integrate(dt, damp) {
      const scale = dt / GFI.DT;
      for (let i = 0; i < n; i++) {
        if (pinMode[i] === PIN_HARD) continue;
        // ⚠ 这里是 d3-force 的【离散】约定：力直接往速度上累加，不乘 dt。
        //
        //   早先写成 v += a·dt 且 x += v·dt，两个 dt 叠加把力削弱了 3600 倍。
        //   后果不是"慢一点"，而是图谱在 alpha 衰减耗尽之前根本来不及收敛，
        //   冻结在半塌缩的错误状态 —— 表现为 p50 边长稳定在 linkDistance 的
        //   3~10 倍，而且对 charge 的响应完全非线性。
        //
        //   所以：速度单位 = 世界单位 / tick，力常数直接采用 d3 的数值范围。
        //   需要 wu/s 的地方（激波、甩掷）在边界乘 GFI.DT 换算。
        vx[i] = (vx[i] + ax[i]) * damp;
        vy[i] = (vy[i] + ay[i]) * damp;
        x[i] += vx[i] * scale;
        y[i] += vy[i] * scale;

        // 防御：任何一步发散成 NaN 都会永久污染，就地复位
        if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) {
          x[i] = GFI.util.jitter(i, 7, 400);
          y[i] = GFI.util.jitter(i, 11, 400);
          vx[i] = 0; vy[i] = 0;
        }
      }
    }

    // -----------------------------------------------------------------------
    // forceCollide —— 位置修正（不是力）
    // -----------------------------------------------------------------------
    function forceCollide(iterations) {
      if (iterations <= 0) return;
      const { radius } = D;
      const cols = collideGrid.cols, rows = collideGrid.rows;
      if (!cols || !rows) return;

      const cellStart = collideGrid.cellStart, items = collideGrid.items;
      const inv = collideGrid.inv, gMinX = collideGrid.minX, gMinY = collideGrid.minY;
      const maxR = cfg.collideCell * 0.5;

      for (let it = 0; it < iterations; it++) {
        for (let i = 0; i < n; i++) {
          if (!activeMask[i] || pinMode[i] === PIN_HARD) continue;
          const xi = x[i], yi = y[i], ri = radius[i];

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
                const rr = ri + radius[j];
                if (d2 >= rr * rr || d2 === 0) continue;
                const d = Math.sqrt(d2);
                const overlap = rr - d;
                const push = overlap * 0.5 * cfg.collideStrength;
                const ux = dx / d, uy = dy / d;
                if (pinMode[i] !== PIN_HARD) { x[i] -= ux * push; y[i] -= uy * push; }
                if (pinMode[j] !== PIN_HARD) { x[j] += ux * push; y[j] += uy * push; }
              }
            }
          }
        }
      }
    }

    // -----------------------------------------------------------------------
    // 主 tick
    // -----------------------------------------------------------------------
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

      // 力都累加进 ax/ay（在当前 x 处求值）
      forceLink(a);

      sim.chargeSkip = (sim.chargeSkip + 1) % Math.max(1, lodCfg.chargeEveryNth);
      if (sim.chargeSkip === 0) {
        chargeGrid.build(D, activeMask);
        forceManyBody(a, cfg.skipIsolatedCharge || lodCfg.skipIsolatedCharge);
      }

      forceGravity(a);
      forceIsolatedRing();

      // 阻尼：帧率无关。retain 是 60Hz 下的每 tick 保留率
      const damp = Math.pow(cfg.velocityRetain, dt / DT);

      integrate(dt, damp);

      // 碰撞需要自己的微网格 —— 节点位置刚变过，必须重建
      if (lodCfg.collideIter > 0 && a > 0.05) {
        collideGrid.build(D, activeMask);
        forceCollide(lodCfg.collideIter);
      }

      forceCenter();

      sim.tickCount++;
    };

    // -----------------------------------------------------------------------
    // 控制 API
    // -----------------------------------------------------------------------
    sim.reheat = function reheat(a) {
      if (a > sim.alpha) sim.alpha = a;
      sim.asleep = false;
    };

    sim.setAlphaTarget = function setAlphaTarget(a) { sim.alphaTarget = a; };

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

    sim.isAwake = function isAwake() { return sim.alpha > sim.alphaMin; };

    sim.reset = function reset() {
      zeroForces();
      vx.fill(0, 0, n);
      vy.fill(0, 0, n);
    };

    return sim;
  }

  GFI.Physics = { create, PIN_NONE, PIN_HARD };
})(window.GFI);
