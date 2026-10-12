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
        // 度数分配力
        const biasT = sum > 0 ? ds / sum : 0.5;   // 作用在 t 上的权重
        const biasS = 1 - biasT;

        const be = (boosting && (s === dragBoostNode || t === dragBoostNode))
          ? dragBoostFactor : 1;
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
        const ci = Math.abs(charge[i]) * swi;

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
              if (j <=  i) continue;                    // 只算一次，对称施加
              if (!activeMask[j]) continue;
              // 跨组（孤立 ↔ 连通）配对跳过
              if (skipIsolated && (deg[j] === 0) !== isoI) continue;
              const dx = x[j] - xi, dy = y[j] - yi;
              const d2 = dx * dx + dy * dy;
              if (d2 > R2 || d2 < 1e-12) continue;

              const d = Math.sqrt(d2);
              const dd = d < minD ? minD : d;

              // 用平均电荷，避免 i、j 电荷不等时失去对称性
              const swj = simWeight[j];
              const cj = Math.abs(charge[j]) * swj;
              const cAvg = (ci + cj) * 0.5;

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
        // 被固定的节点不参与积分（applyPins 每 tick 把坐标钉回去并把速度清零），
        // 所以【接收】的力对它没用 —— 但上面那一整对相互作用已经算完了，
        // 这里只是不往自己身上累加。豁免必须在这个粒度上，见外层循环的说明。
        if (pinMode[i] !== PIN_HARD) { ax[i] += axi; ay[i] += ayi; }
      }
    }

    // 向心力计算
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

    // forceCenter —— 质心刚性回正
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

    // forceIsolatedRing —— 把零度节点锚在外圈环上
    //
    // 零度节点没有连边力，只受斥力和微弱重力，位置基本是随机的 ——
    // 结果就是飘在主干中间挡住别的节点。
    //
    // 用【持续拉力】把半径锚定到环上，而不是直接摆位置：
    // 这样它们仍然可拖拽、也能被激波推着走，只是会被缓慢拉回环上。
    // 刻意【不乘 alpha】：乘了的话模拟一沉降，力就消失，它们又飘回去了。
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

    // 积分
    function integrate(dt, damp) {
      const scale = dt / GFI.DT;
      // 🌟 被拖节点的邻居要【额外加阻尼】—— 否则拖 hub 时它们会以 ~11Hz 抽搐。
      //
      // 为什么：这台引擎的离散步进是 v' = D·(v − k·x)、x' = x + v'，特征方程
      //   trace = 1 + D(1−k)、det = D（D = velocityRetain）。det < 1 恒稳定，
      //   但 k 一变大就进【深欠阻尼区】—— 振荡周期 ≈ 5.3 帧（11Hz），每周期只
      //   衰减 15%，肉眼就是抽搐。而 k = a · lstr · be · biasT：
      //     · 拖叶子：被拖的是低度数端，邻居是 hub，biasT 很小 → k 很小 → 不抖
      //     · 拖 hub：邻居是【叶子】(lstr = clamp(0.3/1,…) = 0.3) 且 biasT = 56/57
      //       ≈ 0.98，力几乎全给叶子 → k = 0.3×0.3×16×0.98 ≈ 1.41 → 剧烈振铃
      //   实测（test/drag-jitter-probe.js，拖 deg=56 的 hub）：
      //     be=1 → 邻位位移折返率 0.1%；be=16 → 21.9%（复现了实机的"抽搐"）
      //
      // 关键：刚度倍率只放大【弹簧力】，不放大阻尼 —— 所以必须配套补上，
      // 否则增益越大力越抖。临界阻尼条件 (1 + D(1−k))² = 4D，k=1.41 → D ≈ 0.21。
      //
      // ⚠ 但阻尼【不能一刀切给所有邻居】：拖叶子时邻居是 hub，它只拿到
      //   deg[被拖]/(deg[被拖]+deg[邻]) ≈ 5% 的力（k ≈ 0.07，本来就不振铃），
      //   给它上重阻尼只会白白抹掉"邻居跟随"的好处 —— 实测跟随度从 100wu 退到
      //   117wu，比【不加增益】还差。所以按每个邻居实际拿到的力份额线性混合阻尼：
      //     份额 ≈ 1（拖 hub，邻居是叶子）→ 用满阻尼，压掉 11Hz 振铃
      //     份额 ≈ 0（拖叶子，邻居是 hub）→ 用正常阻尼，一分好处都不丢
      const dm = GFI.config.drag.linkBoostDamp;
      const dampBoosted = (dragBoostNode >= 0 && dm > 0 && dm < 1) ? Math.pow(dm, scale) : damp;
      const dampDelta = dampBoosted - damp;
      for (let i = 0; i < n; i++) {
        if (pinMode[i] === PIN_HARD) continue;
        const di = dampDelta !== 0 ? damp + dampDelta * dragBoostBlend[i] : damp;
        // ⚠ 这里是 d3-force 的【离散】约定：力直接往速度上累加，不乘 dt。
        //
        //   早先写成 v += a·dt 且 x += v·dt，两个 dt 叠加把力削弱了 3600 倍。
        //   后果不是"慢一点"，而是图谱在 alpha 衰减耗尽之前根本来不及收敛，
        //   冻结在半塌缩的错误状态 —— 表现为 p50 边长稳定在 linkDistance 的
        //   3~10 倍，而且对 charge 的响应完全非线性。
        //
        //   所以：速度单位 = 世界单位 / tick，力常数直接采用 d3 的数值范围。
        //   需要 wu/s 的地方（激波、甩掷）在边界乘 GFI.DT 换算。
        vx[i] = (vx[i] + ax[i]) * di;
        vy[i] = (vy[i] + ay[i]) * di;
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

    // forceCollide —— 位置修正（不是力）
    function forceCollide(iterations) {
      if (iterations <= 0) return;
      const { radius } = D;
      const cols = collideGrid.cols, rows = collideGrid.rows;
      if (!cols || !rows) return;

      const cellStart = collideGrid.cellStart, items = collideGrid.items;
      const inv = collideGrid.inv, gMinX = collideGrid.minX, gMinY = collideGrid.minY;

      // 🌟 d3 forceCollide 的 padding 约定：每节点外扩 pad，两节点静止间距 =
      //   r_i + r_j + 2·pad。没有它，斥力/弹簧/重力的压力会把节点一路压到
      //   【接触距离】才停（实测最近邻 p10 = 13.6 ≈ 两片叶子半径之和 6.8+6.8，
      //   表现就是整团挤成一坨）；有了它，节点之间永远留出可见空隙。
      const pad2 = cfg.collidePad * 2;

      for (let it = 0; it < iterations; it++) {
        for (let i = 0; i < n; i++) {
          if (!activeMask[i] || pinMode[i] === PIN_HARD) continue;
          const xi = x[i], yi = y[i], ri = radius[i];
          // 自己的半径 + 可能遇到的最大半径 = 需要扫描的半边长。
          // 小节点自动用小框（比原来固定 16 还快），hub 用大框（不漏检）。
          // ⚠ 2·pad 必须计入搜索半径，否则 padding 大了会漏检最远的一对。
          //
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
                  // ⚠ 完全重合：归一化方向未定义，`d2 === 0` 直接 continue 会把
                  //   这对节点【永久】留在叠死状态（数据重载按 id 继承位置时
                  //   可能产生）。用确定性哈希取方向把 j 推开。
                  const a0 = GFI.util.hash11s(j, 91) * Math.PI * 2;
                  ux = Math.cos(a0); uy = Math.sin(a0);
                  d = 1;                        // overlap = rr-1 ≈ rr，正好一次推到接触
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

      // 碰撞需要自己的微网格 —— 节点位置刚变过，必须重建。
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

    // 拖拽期间给【被拖节点关联的边】临时加刚度，让邻居跟着走（见 forceLink 注释）。
    // 传 i = -1 结束增益。factor 由调用方校验，这里只做形状防御。
    sim.setDragLinkBoost = function setDragLinkBoost(i, factor) {
      dragBoostNode = (typeof i === 'number' && i >= 0 && i < n) ? i : -1;
      dragBoostFactor = (factor > 0 && Number.isFinite(factor)) ? factor : 1;
      // O(n) 填充，但只在 dragstart / 松手各调一次，可忽略
      dragBoostBlend.fill(0, 0, n);
      if (dragBoostNode >= 0) {
        // 份额 = forceLink 里这条边作用在该邻居身上的权重。
        // 对边 (s,t)：作用在 t 上的 biasT = deg[s]/(deg[s]+deg[t])，作用在 s 上的
        // biasS = 1−biasT。两端合起来正好等于【被拖节点度数占两边度数之和的比例】，
        // 与被拖节点是 src 还是 tgt 无关 —— 所以这一行就够了。
        const di = deg[dragBoostNode];
        const s = D.adjStart[dragBoostNode], e = D.adjStart[dragBoostNode + 1];
        for (let p = s; p < e; p++) {
          const j = D.adjList[p];
          dragBoostBlend[j] = di / (di + deg[j]);
        }
      }
    };

    sim.setAlphaTarget = function setAlphaTarget(a) { sim.alphaTarget = a; };

    /**
     * 把模拟按到「刚入睡」的状态：alpha 回到 alphaMin、速度与受力清零。
     *
     * 用途见 src/warm.js：预热器把同一个物理跑到底、取出坐标，接管方再用这套
     * 坐标重建管线。重建出来的 sim 是从 alpha=1 起步的 —— 不按一下的话，
     * 第一帧之后图谱会从「已经沉降好的布局」再往下塌一次，正好毁掉
     * 「打开即最终形态」。alphaTarget 一并归零：拖拽路径会把它抬到 0.3，
     * 残留的话新图会一直醒着（同 main.js 空闲停机那条约束）。
     */
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

    // 右键固定/解除固定（interaction.js 的 contextmenu）需要读当前 pin 态
    sim.isPinned = function isPinned(i) {
      if (i < 0 || i >= n) return false;
      return pinMode[i] === PIN_HARD;
    };

    sim.isAwake = function isAwake() { return sim.alpha > sim.alphaMin; };

    // 渲染剔除与命中测试复用 chargeGrid，而它平常只在 tick 内部重建 ——
    // 前提是「模拟睡着 ⇒ 没有任何东西移动」。applyHandoff 会绕过模拟直接写
    // D.x / D.y，破坏了这个前提；模拟睡着时这条通道让外面能按需把网格刷新回来。
    // 只在 settle 活跃期间每帧调用（最多几百毫秒），O(n) 可忽略。
    sim.rebuildGrid = function rebuildGrid() {
      updateActiveMask();
      chargeGrid.build(D, activeMask);
    };

    return sim;
  }

  GFI.Physics = { create, PIN_NONE, PIN_HARD };
})(window.GFI);
