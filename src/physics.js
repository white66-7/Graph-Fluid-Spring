/*
 * GFI.Physics — 力导向模拟
 * 配合二阶位置项：
 *     a = F(x)/m
 *     x' = x + v·dt + 0.5·a·dt²
 *     v' = (v + a·dt) · damp
 * 严格的 velocity Verlet 需要每 tick 求两次力（~2× 斥力开销）。在 dt=1/60、
 * damp≈0.94 时两者差异不可观测，不值得。
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

    // 碰撞搜索半径必须覆盖 r_i + r_j 的最大可能值，而它【不是】固定值：
    // 半径随度数增长（render.radiusMax=14，再乘 nodeSize）。
    // 原来这里写的是 collideCell*0.5 = 16 —— 两个高度数节点（r≈9.2）就要求
    // 18.4 才不漏检，本来就偏小；render.nodeSize 一放大更是直接漏掉大半碰撞，
    // 表现是节点叠在一起。这里按实际数据取上界，一次 O(n)，之后是常量。
    let maxNodeR = 0;
    for (let i = 0; i < n; i++) if (D.radius[i] > maxNodeR) maxNodeR = D.radius[i];

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
    //
    // 🌟 拖拽期间的【局部弹簧增益】（sim.setDragLinkBoost）。
    //
    // 为什么需要它：lstr[e] = clamp(linkStrength / minDeg, 0.02, 0.5)，即边的刚度
    // 按两端较【低】度数衰减。而被拖的通常就是低度数叶子，它连到 hub 的边刚度只有
    // 0.3/3 = 0.1，再乘 alpha 0.3 —— 邻居每 tick 只获得约 0.7wu 的加速度。
    // 实测（test/drag-probe.js，拖 234wu）：邻居只跟出 91wu，关联边被拉伸到
    // 379%，松手瞬间被拖节点离最近邻居 142wu（基线 26.4、平衡边长 50）——
    // 图被扯裂，松手就是把这根橡皮筋收回来，怎么收都不舒服。
    //
    // 只增益【被拖节点自己关联的边】，不动别的边：实测 2~3 跳增益反而更差
    // （局部造出一块硬斑对抗全局布局，全局撕裂均值 63% → 110%）。
    //
    // 用独立的两个标量而不是去改 D.lstr：D.lstr 在 Data.build 时烘焙，
    // 若拖拽期间发生数据重建，写回旧值会污染新图。标量天然免疫。
    // -----------------------------------------------------------------------
    let dragBoostNode = -1;
    let dragBoostFactor = 1;
    // 被拖节点每个【直接邻居】的额外阻尼混合系数（0 = 用正常阻尼，1 = 用满阻尼）。
    // 值 = 该邻居在增益边上实际拿到的力份额，见 integrate 里的说明。
    const dragBoostBlend = new Float32Array(n);

    function forceLink(a) {
      const { m, lsrc, ltgt, ldist, lstr, lvisible } = D;
      const boosting = dragBoostNode >= 0;
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

        const be = (boosting && (s === dragBoostNode || t === dragBoostNode))
          ? dragBoostFactor : 1;
        const l = (d - ldist[e]) / d * a * lstr[e] * be * ws * wt;

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
        // ⚠ 这里【不能】因为 i 被固定就 continue —— 内层只处理 j > i 的那一对
        //   （`if (j <= i) continue;`，每对只算一次、对称施加），所以跳掉外层 i
        //   等于把整对 (i, j>i) 一起抹掉：两个方向的力都没了。
        //   结果：被固定的节点对【高序号】邻居完全"斥力隐身"，对低序号邻居却正常
        //   （那一对由低序号方作外层索引时被处理）。是序号相关的非对称。
        //   表现：右键固定一个节点后，序号比它大的邻居会往它身上挤。
        //
        //   这与下面零度节点那条是同一类错误：守卫写在【外层循环】上，就会连带
        //   抹掉成对的相互作用。被固定的节点不需要【接收】力（applyPins 每 tick
        //   把它的坐标钉回去、速度清零），但必须照常【施加】力 —— 所以豁免只能
        //   写在末尾的累加处，不能写在这里。
        //   回归测试：test/headless-sim.js §17。
        if (!activeMask[i]) continue;
        // skipIsolated 的含义是「孤立节点不扰动主干」，而不是「孤立节点之间不作用」。
        // 早先整行跳掉零度节点，导致环上的孤立节点彼此完全不排斥、会叠在一起
        // （实测最小角间隔只有 1.6°）。现在只跳过【跨组】配对。
        const isoI = deg[i] === 0;

        const xi = x[i], yi = y[i];
        // 🌟 电荷按 simWeight 加权：新节点出生时 simWeight 从 0 渐入，
        //   它的斥力也就跟着渐入，而不是落在邻居质心上就用满幅把人家顶开。
        //   ⚠ 顺带补上一个既有的对称性缺口：淡出时 simWeight 已经在降，但之前
        //     斥力只看二值的 activeMask —— 节点一直满强度排斥到最后一帧才突变。
        const swi = simWeight[i];
        const ci = Math.abs(charge[i]) * swi;

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
              const swj = simWeight[j];
              const cj = Math.abs(charge[j]) * swj;
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
        // 被固定的节点不参与积分（applyPins 每 tick 把坐标钉回去并把速度清零），
        // 所以【接收】的力对它没用 —— 但上面那一整对相互作用已经算完了，
        // 这里只是不往自己身上累加。豁免必须在这个粒度上，见外层循环的说明。
        if (pinMode[i] !== PIN_HARD) { ax[i] += axi; ay[i] += ayi; }
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

      // 碰撞需要自己的微网格 —— 节点位置刚变过，必须重建。
      // ⚠ 这里【不能用 alpha 门控】（曾经写 a > 0.05 才跑，是个真 bug）：
      //   alpha ∈ (alphaMin, 0.05) 的尾段里节点仍在被移动 —— isolatedRing 的拉力
      //   刻意不乘 alpha（否则模拟一沉降孤立节点就飘回去），残余的弹簧力也还没
      //   归零 —— 而碰撞停了，于是这段窗口里产生的重叠被【永久冻结】在最终布局
      //   里，表现就是图上成对叠在一起的节点。碰撞是位置修正不是力，只要醒着
      //   就必须每 tick 跑。
      if (lodCfg.collideIter > 0) {
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
