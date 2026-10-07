/*
 * GFI.Timeline — 时间旅行（Obsidian 细胞分裂动态模型）
 * ===========================================================================
 * 可见性判定只有一次比较：  !(createdAt[i] > cutoff)
 *   因为 createdAt 缺失存的是 NaN，而 NaN > cutoff 恒为 false
 *   → 没有时间戳的节点永远可见，无需存在性分支。
 *
 * ── Obsidian 风格核心机制：母体细胞分裂（Cell Budding） ──
 *
 * 1. 细胞分裂式诞生：
 *    新节点出生时不再摆放在抽象的“邻居几何中心”，而是直接紧贴其引用的母节点
 *    （母体）诞生。
 *
 * 2. 动量守恒与后坐力（Action-Reaction）：
 *    子节点诞生瞬间被赋予背离母体的喷射初速度；同时母节点承受反向后坐力推力。
 *    原本长度接近 0 的连线被瞬间拉伸紧绷，产生强烈的弹簧回弹与团簇震颤。
 *
 * 3. 首帧全受力：
 *    simWeight 直接从 1.0 开始，连线拉力第 1 帧全力介入，杜绝“隐形中弹完”的现象。
 */
(function (GFI) {
  'use strict';
  if (GFI.Timeline) return;

  const { clamp, jitter } = GFI.util;

  function create(D, sim, fx, hooks) {
    const cfg = GFI.config;
    hooks = hooks || {};

    const range = GFI.Data.timeRange(D);

    const tl = {
      range,
      cutoff: range ? range.max : Infinity,   // = "现在"，全部可见
      playing: false,
      speed: 1,
      speedIdx: 1,
      // 🌟 播放游标：已「轮到」的节点个数（浮点）。见下面「按秩推进」。
      rank: 0,
      rate: 0,            // 诞生速率（节点/秒），create 期算一次
      pacedCount: 0,      // 有时间戳的节点数 = 可被时间旅行揭示的规模
      playDurationSec: 0, // 全程秒数 = pacedCount / rate（是【结果】，不是设定值）
      rateAuto: false,    // true = 速率来自 Obsidian 公式（revealRate 设成 0）
    };

    const _centroid = { x: 0, y: 0, k: 0 };
    let lastPulseAt = -1e9;

    // 🌟 出生缓动模式（config.pop.mode）。'obsidian' 时【不注入】喷射初速、
    //   也不加母节点后坐力 —— 实测 Obsidian 的 setData 里没有这两样。
    const obsidianMode = cfg.pop.mode === 'obsidian';

    // 本帧新生节点总数（pass A 填）。只给 Obsidian 落点公式的抖动半径用：
    //   app.js 里 F = 60·√I，I = 本批新节点数。
    let revealBatch = 1;

    // 🌟 T1 出生分槽的复用缓冲 —— create 期一次分配，逐帧零分配。
    //   revealSlot[p] 两阶段复用：pass A 当「本帧子节点计数」，pass B 当「槽位游标」，
    //   pass B 结束时恰好减回 0，无需清理；每帧开头 fill(0) 清掉上一帧的残值。
    //   GOLDEN = 黄金角 137.5°：整数倍轮转在圆周上均匀散开，任意子数都不重缝。
    const revealSlot = new Int32Array(D.n);
    const parentOf = new Int32Array(D.n);
    const GOLDEN = Math.PI * (3 - Math.sqrt(5));

    // =======================================================================
    // 🌟 按秩推进（Rank-paced playback，2026-10-07）
    // =======================================================================
    // 旧实现：cutoff 每帧推进固定【毫秒】数（range.duration / baseDurationSec）。
    // 两种真实分布都会把它打坏（实测见 test/timeline-pacing-probe.js）：
    //
    //   · 大簇 —— 批量导入 / 重建 DB 后一大批页面共享同一个 createdAt，
    //     applyCutoff 在某【一帧】里把整簇置 want=1，等于"炸一下"，
    //     随后是长时间无事发生。
    //   · 稀疏年代 —— 中间几个月没有新页面，白耗掉成比例的时长。
    //
    //   实测：3000 节点、60% 挤在导入日 ⇒ 峰值一帧揭示 982 个、
    //   达成 50% 只用了 0.02s，剩下 20 秒几乎空转。
    //   反过来 100 节点时 94% 的帧什么都没发生（全程 28 秒干等）。
    //
    // 新实现：游标换成【已轮到的节点序号 rank】，每帧推进 rate 个序号而非毫秒。
    //
    //   🌟 rate 现在是【用户直接设的旋钮】（config.timeline.revealRate，节点/秒），
    //     全程时长 = pacedCount / rate 是它的【结果】，不是设定值。
    //     曾经反过来做（设总时长 → 反推速率 → 再拿护栏钳速率），代价是：
    //       · 同一个时长小图太快、大图太慢，用户没法用一个数表达两边；
    //       · 护栏会把用户显式设的时长顶掉（设 60 秒卡回 32 秒）。
    //     直接设速率就没有反推、没有护栏、没有覆盖。
    //
    // ⚠ 光有 rank 是【摊不开】大簇的：cutoff = sortedTs[k] 一步就把整簇置 want=1。
    //   所以还必须配一个每帧「揭示额度」（见 setCutoff 的 revealBudget）——
    //   rank 决定【什么时候轮到这批】，额度决定【这批分多少帧冒出来】。缺一不可：
    //     · 只上 rank 不上额度 → rank 把整簇该用的时长（如 704/1200 ⇒ 16 秒）
    //       排给了它，可它一帧就放完了，那 16 秒变成纯死等。
    //     · 只上额度不上 rank（= 旧的按毫秒推进 + 额度）→ 进度条按【时间戳】走、
    //       画面按【额度】放，两者脱节。实测（N=1200、60% 同一毫秒）t=15s 时
    //       进度条才 53.6%，画面却已经放出 75%，最大差 21 个百分点。
    //   两者都用 rate 计量，所以稳态下额度 = rate·dt 恰好等于供给量、零额外延迟
    //   （实测均匀分布下全程 28.02s vs 28.02s，差 0.00%），只在成簇时限流 ——
    //   本质是一个免费的突发平滑器。
    const sortedTs = (function () {
      const a = [];
      for (let i = 0; i < D.n; i++) {
        const t = D.createdAt[i];
        if (Number.isFinite(t)) a.push(t);
      }
      a.sort((x, y) => x - y);
      return Float64Array.from(a);
    })();
    const pacedCount = sortedTs.length;

    // 二分：sortedTs 中 <= ms 的元素个数 —— 该 cutoff 对应的 rank
    function rankUpTo(ms) {
      let lo = 0, hi = pacedCount;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sortedTs[mid] <= ms) lo = mid + 1; else hi = mid;
      }
      return lo;
    }

    // rank → cutoff。rank 是浮点游标，floor 一下就是「本轮该揭示到第几个节点」。
    // 注意这里给的是第 k 个节点的【时间戳】，同时间戳的兄弟会被一并置 want=1，
    // 由揭示额度负责把它们摊到后续若干帧。
    function cutoffAtRank(rank) {
      const k = Math.floor(rank);
      if (k <= 0) return range ? range.min - 1 : -Infinity;   // 还差一点才轮到第一个
      return sortedTs[Math.min(pacedCount, k) - 1];
    }

    // 还有没有「已判定该出现、但被额度挡在门外」的节点
    function hasPendingReveal() {
      const want = D.wantVisible, vis = D.visible;
      for (let i = 0; i < D.n; i++) if (want[i] && !vis[i]) return true;
      return false;
    }

    tl.pacedCount = pacedCount;
    // 🌟 速率：用户设的数（节点/秒）；设成 0 = 自动套用 Obsidian 的公式。
    //
    //   Obsidian 实测（app.js，renderProgression）：
    //     progressionSpeed = clamp(0.5·√边数, 5, 100)     ← 节点/秒
    //     progression      = 1 + floor(速率 × 已过秒数)   ← 按墙钟【线性】，无缓动
    //   所以 Obsidian 的 rhythm 就是「恒定节点数/秒」，只是速率随边数按 √ 增长。
    //
    //   全程时长是速率的【结果】，不是设定值。clamp 只防手改配置改出
    //   负数 / Infinity 导致除零或时间倒流。
    const rawRate = Number(cfg.timeline.revealRate);
    tl.rateAuto = rawRate === 0;
    tl.rate = tl.rateAuto
      ? clamp(0.5 * Math.sqrt(D.m), 5, 100)     // ← Obsidian 原公式，逐字照抄
      : clamp(rawRate || 0, 0.05, 200);
    tl.playDurationSec = pacedCount / tl.rate;
    // ⚠ 游标初值必须与 cutoff 初值一致。create 时 cutoff = range.max（全可见），
    //   所以 rank 也得是 pacedCount；字面量里那个 rank: 0 只是占位。
    //   不补这一句的后果：中途按播放（没经过倒带，也没拖过滑块）会从 rank 0
    //   起跳，时间轴直接从头重放一段。
    tl.rank = rankUpTo(tl.cutoff);

    // =======================================================================
    // 脉冲（可选的背景扰动波）
    // =======================================================================
    function changedCentroid() {
      let cx = 0, cy = 0, k = 0;
      for (let i = 0; i < D.n; i++) {
        if (D.wantVisible[i] === D.visible[i]) continue;
        cx += D.x[i]; cy += D.y[i]; k++;
      }
      if (!k) return null;
      return { x: cx / k, y: cy / k, k };
    }

    function maybePulse(forward, origin, viewportWorldHeight) {
      // 🌟 T2：shock.magnitude = 0（默认）时 pulse 必然早退、波根本不会发射 ——
      //   在做任何 O(n) 工作（centroid/bounds）之前就返回。旧代码走到最后的
      //   sim.reheat(0.5) 是【无条件】的：波没发出去，图却被重热得比
      //   reheat.timelinePlay(0.32) 还狠，播放期间每 pulseThrottleMs 白翻腾一次。
      if (!(cfg.shock.magnitude > 0)) return;

      const now = GFI.util.now();
      if (now - lastPulseAt < cfg.timeline.pulseThrottleMs) return;
      if (fx.pulsesActive && fx.pulsesActive()) return;

      lastPulseAt = now;
      const o = origin || GFI.Data.centroid(D, true, _centroid);

      const b = GFI.Data.bounds(D, false);
      const radius = Math.max(
        cfg.physics.linkDistance * 4,
        Math.hypot(b.maxX - b.minX, b.maxY - b.minY) * 0.5 * cfg.shock.maxRadiusFactor
      );

      // 🌟 pulse() 返回是否真的发射了波（幅度可能被钳到 0）—— 只在真发射时重热
      const fired = fx.pulse({
        ox: o.x,
        oy: o.y,
        sign: forward ? 1 : -1,
        viewportWorldHeight,
        maxRadius: radius,
      });
      if (fired) sim.reheat(cfg.reheat.pulse);
    }

    // =======================================================================
    // 揭示锚点：Obsidian 母体细胞分裂计算
    // =======================================================================
    // 母体 = 度数最高且【已可见】的邻居。⚠ 必须在本帧任何 beginReveal 把
    // 兄弟节点置 visible=1 之前调用 —— 否则同帧的兄弟可能互相选成母体，
    // 每个节点的母体就取决于遍历顺序了。setCutoff 的 pass A 已保证这一点。
    function findParent(i) {
      const s = D.adjStart[i], e = D.adjStart[i + 1];
      let parentIdx = -1;
      let maxDeg = -1;
      for (let p = s; p < e; p++) {
        const j = D.adjList[p];
        if (!D.visible[j]) continue;
        if (D.deg[j] > maxDeg) {
          maxDeg = D.deg[j];
          parentIdx = j;
        }
      }
      return parentIdx;
    }

    // parentIdx / slot 由 setCutoff 的两趟扫描传入（pass A 计数、pass B 发射），
    // slot 是该节点在【同一母体同帧兄弟】里的黄金角序号。
    function anchorFor(i, visCentroid, parentIdx, slot) {
      // 🌟 情况 0：Obsidian 模式 —— 落在【所有已存在邻居的质心】± 随机撒布。
      //   实测 app.js setData：
      //     对新节点逐个求「already-present 邻居」的位置均值 (N/H, V/H)，
      //     再加 (Math.random()-.5)*F 的抖动，F = sqrt(60*I*60) = 60·√I
      //     （I = 本批新节点数；单位是 Obsidian 的世界单位，其 linkDistance=250）。
      //
      //   为什么这条比「紧贴单个母体 3px」更能把其他节点推开：
      //   质心落点会同时压到【多个】邻居身上，碰撞/斥力把每一个都往外顶；
      //   而贴单母体只顶一个。这正是在 Obsidian 里「节点出现把邻居推开」的由来
      //   （力的层面它只做了 alpha:.3 重热，落点就是这里）。
      //
      //   抖动量按线长折算：Obsidian 的 ±30·√I / 250 ≈ 0.12·√I 倍 linkDistance。
      if (obsidianMode) {
        const s = D.adjStart[i], e = D.adjStart[i + 1];
        let cx = 0, cy = 0, k = 0;
        for (let p = s; p < e; p++) {
          const j = D.adjList[p];
          if (!D.visible[j]) continue;
          cx += D.x[j]; cy += D.y[j]; k++;
        }
        if (k > 0) {
          const spread = 0.12 * cfg.physics.linkDistance * Math.sqrt(Math.max(1, revealBatch));
          return {
            parentIdx: -1,
            x: cx / k + jitter(i, 51, spread),
            y: cy / k + jitter(i, 52, spread),
            dirX: 0, dirY: 0,
          };
        }
        // 没有已存在的邻居 → 落到下面的情况 2 / 3（外圈滑入 / 创世）
      }

      // 情况 1：存在母节点 —— 紧贴母节点向外侧爆破喷射
      if (parentIdx !== -1) {
        const px = D.x[parentIdx];
        const py = D.y[parentIdx];

        // 基础方向：沿母体背离全图质心的外展方向
        const cx = visCentroid && visCentroid.k > 0 ? visCentroid.x : px;
        const cy = visCentroid && visCentroid.k > 0 ? visCentroid.y : py;
        let angle = Math.atan2(py - cy, px - cx);

        if (Math.abs(px - cx) < 1e-3 && Math.abs(py - cy) < 1e-3) {
          angle = jitter(i, 30, Math.PI);
          // 🌟 T1：黄金角轮转取代「±0.78rad 各自乱抖」—— 快进/拖滑块大步时
          //   同一母体的多个子节点同帧从同一个 3px 点叠着喷出，靠碰撞逐帧顶开，
          //   观感是「炸出一坨」。137.5° 一档让兄弟从第一个 tick 就彼此错开；
          //   哈希微扰降到 ±14°，只负责去掉机械感。确定性哈希，无随机源。
          angle += slot * GOLDEN;
        } else {
          angle += slot * GOLDEN + jitter(i, 31, 0.25);
        }

        const dirX = Math.cos(angle);
        const dirY = Math.sin(angle);

        // 仅偏移 3 像素出生，视觉呈现出纯正的从母节点裂变而出的质感
        return {
          parentIdx,
          x: px + dirX * 3.0,
          y: py + dirY * 3.0,
          dirX,
          dirY,
        };
      }

      // 情况 2：无母节点的孤立节点 —— 从外圈向内滑入
      if (visCentroid && visCentroid.k > 0) {
        const angle = jitter(i, 32, Math.PI);
        const dist = cfg.physics.linkDistance * 2.2 + jitter(i, 33, 40);
        return {
          parentIdx: -1,
          x: visCentroid.x + Math.cos(angle) * dist,
          y: visCentroid.y + Math.sin(angle) * dist,
          dirX: -Math.cos(angle),
          dirY: -Math.sin(angle),
        };
      }

      // 情况 3：初始创世节点（图谱完全为空）
      const angle = jitter(i, 34, Math.PI);
      const r = 20 + jitter(i, 35, 30);
      return {
        parentIdx: -1,
        x: Math.cos(angle) * r,
        y: Math.sin(angle) * r,
        dirX: Math.cos(angle),
        dirY: Math.sin(angle),
      };
    }

    // =======================================================================
    // 设置 cutoff
    // =======================================================================
    tl.setCutoff = function setCutoff(ms, opts) {
      opts = opts || {};
      const prevCutoff = opts.prevCutoff !== undefined ? opts.prevCutoff : tl.cutoff;
      // 每帧揭示额度。只有播放路径会给定；拖滑块 / 切类型 / reset 必须是
      // 即时的，传 Infinity（= 不限额）。
      const budget = (opts.revealBudget === undefined) ? Infinity : opts.revealBudget;
      const instantHide = !!opts.instantHide;

      const changed = GFI.Data.applyCutoff(D, ms);
      tl.cutoff = ms;
      // 秩游标同步。⚠ 外部（拖滑块 / 类型开关 / reset）按二分回推即可；
      // 播放路径【必须】自己传 opts.rank —— 回推会把同时间戳大簇的游标
      // 一路顶到簇尾，等于整簇一次性放完，突发平滑直接失效。
      tl.rank = (opts.rank !== undefined) ? opts.rank : rankUpTo(ms);
      // 额度没用满 ⇒ 队列里可能还压着「want=1 但 visible=0」的节点，
      // 此时即使本帧 cutoff 没变也不能早退，否则它们永远出不来。
      if (!changed && (budget === Infinity || !hasPendingReveal())) return 0;

      const forward = (opts.forward !== undefined) ? opts.forward : (ms > prevCutoff);
      const origin = changedCentroid();
      const visCentroid = GFI.Data.centroid(D, false, _centroid);

      const doPulse = opts.pulse !== false && !opts.silent
        && changed >= (cfg.timeline.pulseMinReveal || 1);
      if (doPulse) maybePulse(forward, origin, opts.viewportWorldHeight || 0);

      let revealed = 0, hidden = 0;

      // 🌟 T1 pass A：给本帧每个新生节点找母体并按母体计数。
      //   ⚠ 必须赶在任何 beginReveal 把兄弟置 visible=1 之前 —— 母体候选条件
      //   是 visible[j]，这样本帧的兄弟互相看不见、谁也不会被选成母体。
      revealSlot.fill(0, 0, D.n);
      let nPending = 0;
      for (let i = 0; i < D.n; i++) {
        if (D.wantVisible[i] !== 1 || D.visible[i] !== 0) continue;
        const p = findParent(i);
        parentOf[i] = p;
        if (p !== -1) revealSlot[p]++;
        nPending++;
      }
      // ⚠ 抖动半径要的是【本帧实际会揭示的数量】，不是待揭示总数 ——
      //   Obsidian 的 I = g.length = 本次 setData 真正加进去的节点数，
      //   而我们有逐帧揭示额度，所以实际数 = min(待揭示, budget)。
      //   用错会高估抖动半径（实测 13.37wu vs 上界 9.84wu）。
      revealBatch = Math.min(nPending, budget);

      for (let i = 0; i < D.n; i++) {
        const want = D.wantVisible[i];
        const isFading = D.fadeT[i] === D.fadeT[i];

        if (want === 1 && D.visible[i] === 0) {
          // 🌟 每帧揭示额度（突发平滑器）。超额的 continue 掉 —— 它们已经
          //   want=1，下一帧 setCutoff 开头的 hasPendingReveal() 会把队列续上。
          //   稳态下额度 = rate·dt 恰好等于供给量，这里从不触发。
          if (revealed >= budget) continue;

          // ---- 揭示：Obsidian 母体分裂与反冲爆发 ----
          // 🌟 T1 pass B：槽位游标倒序发放 —— pass A 存的是兄弟总数 k，
          //   这里逐个 -- 后得到 k-1 … 0，配合黄金角把兄弟在圆周上错开；
          //   循环结束时每个用过的槽位恰好减回 0，天然为下一帧复位。
          const p = parentOf[i];
          const spawn = anchorFor(i, visCentroid, p, p !== -1 ? --revealSlot[p] : -1);
          D.x[i] = spawn.x;
          D.y[i] = spawn.y;

          if (obsidianMode) {
            // 🌟 Obsidian 模式：**没有**喷射初速、**没有**母节点后坐力。
            //   实测 app.js 的 setData：新节点只是被放到「已存在邻居的均值位置
            //   ± 随机撒布」，除此之外没有任何一处注入速度，动起来全靠力模拟。
            //   而这两样（22wu/s 初速 + 母体反冲）正是「出生太急」的主因 ——
            //   一个节点出生会把整张图连带踢一下。
            D.vx[i] = 0;
            D.vy[i] = 0;
          } else {
            // 🌟 1. 子节点爆发速度（向外猛冲）
            const kickSpeed = 22.0 + jitter(i, 41, 4.0);
            D.vx[i] = spawn.dirX * kickSpeed;
            D.vy[i] = spawn.dirY * kickSpeed;

            // 🌟 2. 母节点后坐力反冲（牛顿第三定律）
            // 子节点向外射出的同时，母节点被向后推退，连线弹簧瞬间被拉得极紧并产生回弹振荡
            if (spawn.parentIdx !== -1) {
              const pIdx = spawn.parentIdx;
              const recoilMass = 1 / (1 + 0.18 * Math.sqrt(D.deg[pIdx]));
              const recoil = kickSpeed * 0.42 * recoilMass;
              D.vx[pIdx] -= spawn.dirX * recoil;
              D.vy[pIdx] -= spawn.dirY * recoil;
            }
          }

          // 🌟 3. 力的权重首帧全开，连线弹簧立即介入工作
          D.simWeight[i] = 1.0;

          // 🌟 4. 取消延迟错峰，诞生即刻爆发
          fx.beginReveal(i, 0);
          revealed++;
        } else if (want === 1 && D.visible[i] === 1 && isFading) {
          // ---- 撤销淡出 ----
          if (fx.cancelHide(i)) revealed++;
        } else if (want === 0 && D.visible[i] === 1 && !isFading) {
          // ---- 隐藏 ----
          // instantHide：倒带场景（重新开始播放）—— 必须一帧清干净。
          // 若走 beginHide 的 0.26s 淡出，节点在这段时间里仍是 visible=1，
          // 紧接着的揭示就会全部命中上面那个 cancelHide 分支、绕过揭示额度。
          if (instantHide) fx.hideNow(i); else fx.beginHide(i);
          hidden++;
        }
      }

      if (revealed || hidden) {
        const revealHeat = opts.playing ? cfg.reheat.timelinePlay : cfg.reheat.cutoff;
        if (hidden) sim.reheat(Math.min(cfg.reheat.fadeStart, revealHeat));
        if (revealed) sim.reheat(revealHeat);
        if (hooks.onChange) hooks.onChange({ revealed, hidden, cutoff: ms });
      }
      return changed;
    };

    tl.setKindOn = function setKindOn(kindIdx, on) {
      const k = kindIdx | 0;
      if (k < 0 || k >= D.kindOn.length) return 0;
      const v = on ? 1 : 0;
      if (D.kindOn[k] === v) return 0;
      D.kindOn[k] = v;
      return tl.setCutoff(tl.cutoff, { forward: !!on, pulse: true });
    };

    tl.isKindOn = function isKindOn(kindIdx) { return !!D.kindOn[kindIdx | 0]; };

    tl.setSliderValue = function setSliderValue(v, opts) {
      if (!range) return 0;
      const prev = tl.cutoff;
      const ms = range.min + clamp(v, 0, range.duration);
      const o = Object.assign({}, opts || {});
      o.forward = ms >= prev;
      o.prevCutoff = prev;
      return tl.setCutoff(ms, o);
    };

    tl.sliderValue = function sliderValue() {
      if (!range) return 0;
      if (tl.cutoff === Infinity) return range.duration;
      return clamp(tl.cutoff - range.min, 0, range.duration);
    };

    tl.progress = function progress() {
      if (!range || !range.duration) return 1;
      return clamp(tl.sliderValue() / range.duration, 0, 1);
    };

    tl.reset = function reset() {
      if (!range) return;
      tl.setCutoff(range.max, { pulse: true, forward: true });
    };

    // =======================================================================
    // 播放
    // =======================================================================
    tl.setPlaying = function setPlaying(p) {
      if (!range) return;
      if (p && tl.sliderValue() >= range.duration - 1) {
        const prev = tl.cutoff;
        // 🌟 倒回【首个节点之前】而不是 range.min。
        //   cutoff = range.min 的语义是「<= min 的都可见」—— 如果最早那一批
        //   时间戳扎堆（导入簇），按秩语义下这等于一按播放就把整簇全放出来，
        //   后面的逐帧额度根本没机会介入。cutoffAtRank(0) = range.min - 1
        //   才是真正的「一个都还没出现」，让第一簇也走正常诞生路径。
        const start = cutoffAtRank(0);
        // instantHide：倒带不能走淡出 —— 淡出期间节点依然 visible=1，
        // 下一帧的揭示会从 cancelHide 分支整簇涌回来，绕开逐帧揭示额度。
        tl.setCutoff(start, { forward: false, pulse: true, instantHide: true });
        tl.setCutoff(start, { forward: true, pulse: false, prevCutoff: prev, instantHide: true });
      }
      tl.playing = !!p;
      lastPulseAt = -1e9;
      if (hooks.onPlayingChange) hooks.onPlayingChange(tl.playing);
    };

    tl.toggle = function toggle() { tl.setPlaying(!tl.playing); };

    tl.setSpeed = function setSpeed(s) { tl.speed = s; };

    tl.cycleSpeed = function cycleSpeed() {
      const speeds = cfg.timeline.speeds;
      tl.speedIdx = (tl.speedIdx + 1) % speeds.length;
      tl.speed = speeds[tl.speedIdx];
      return tl.speed;
    };

    tl.update = function update(dt, viewportWorldHeight) {
      if (!tl.playing || !range || !pacedCount) return;

      // 🌟 按秩推进：本帧新增的量是【节点个数】= rate × speed × dt，
      //   不再是毫秒。speed（0.5/1/2/4）依旧乘在这里，语义不变。
      const step = tl.rate * tl.speed * dt;
      if (step <= 0) return;

      const prev = tl.cutoff;
      const rank = Math.min(pacedCount, tl.rank + step);
      const next = cutoffAtRank(rank);

      const o = {
        forward: true, prevCutoff: prev, viewportWorldHeight, playing: true,
        rank,                       // ⚠ 必须显式传，不能让 setCutoff 回推（见其注释）
      };
      if (cfg.timeline.burstSmoothing !== false) {
        o.revealBudget = Math.max(1, Math.ceil(step));
      }
      tl.setCutoff(next, o);

      // 游标走完【且】队列排空才算结束 —— 否则最后一个大簇会被截断在半路。
      if (rank >= pacedCount && !hasPendingReveal()) {
        tl.playing = false;
        if (hooks.onPlayingChange) hooks.onPlayingChange(false);
      }
    };

    // 起始状态：全部可见
    D.wantVisible.fill(1, 0, D.n);

    return tl;
  }

  GFI.Timeline = { create };
})(window.GFI);