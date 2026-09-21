/*
 * GFI.Effects — Obsidian 动力学特效
 * ===========================================================================
 * 三件事：
 *   (a) pop-out 弹簧   —— 纯渲染层，【绝不进入模拟】
 *   (b) 径向斥力激波   —— 向模拟注入世界空间速度，【绝不触碰相机】
 *   (c) 拖拽惯性着陆   —— 解析解 + 加权混合交接，避免硬 pin 的"啪"一下
 *
 * ── (a) 为什么 pop 不进模拟 ──
 * 它只改 scaleMul[i]，零扰动、零失稳风险，可以逐节点独立增删。
 *
 * ── (b) 为什么必须是"行进波前"而不是单次径向场 ──
 * 单次均匀径向脉冲的视觉签名 = 缩放。改成推进一个波前半径后：
 *   · 每个节点在环带扫过时【恰好被击中一次】
 *   · 远近节点的被击中【时刻不同】—— 相机变换在原理上做不到这一点
 *   · 幅度 ÷ (1 + f·√deg)：重 hub 少动、叶子飞出去 —— 最强的反缩放线索
 *   · 30% 随机抖动：完美径向场看起来像 shader 特效
 *   · 连边力和重力仍在作用 → 节点向外过冲后【弹回并沉降】。缩放永不回弹。
 */
(function (GFI) {
  'use strict';
  if (GFI.Effects) return;

  const { clamp, hash11s, jitter } = GFI.util;

  // 速度单位换算：模拟内部用「世界单位 / tick」，而激波冲量和甩掷速度
  // 是以「世界单位 / 秒」表达的（那是人更容易理解的单位）。
  const DT = GFI.DT;

  const NEARLY_ONE = 0.985;

  function create(D, sim) {
    const n = D.n;
    const cfg = GFI.config;

    // -----------------------------------------------------------------------
    // (a) pop-out 弹簧
    //   S(t) = 1 + A·e^(−ζω₀t)·sin(ω_d t),   ω_d = ω₀√(1−ζ²)
    //   默认 A=0.55, ω₀=22, ζ=0.35 → 峰值 1.328（33% 过冲）、出现在 59ms、520ms 收敛
    //
    //   ⚠ 别拿 drag.jellyDamping(0.76) 来配 pop —— 那只有 2.5% 过冲，几乎看不见弹。
    //     阻尼比 → 过冲：0.2→53%, 0.3→37%, 0.35→31%, 0.5→16%, 0.7→4.6%, 0.76→2.5%
    // -----------------------------------------------------------------------
    function popDuration() {
      const { amp, omega, zeta } = cfg.pop;
      const decay = Math.max(0.0001, zeta * omega);
      // A·e^(−ζω₀t) < 0.01 的时刻
      const t = Math.log(Math.max(1.01, amp / 0.01)) / decay;
      return Math.min(cfg.pop.maxDuration, t);
    }

    // -----------------------------------------------------------------------
    // (b) 激波池（预分配，永不分配）
    // -----------------------------------------------------------------------
    const poolSize = cfg.timeline.poolSize;
    const pulses = [];
    for (let i = 0; i < poolSize; i++) {
      pulses.push({
        active: false, ox: 0, oy: 0,
        r0: 0, rPrev: 0, rCur: 0,
        speed: 0, decayLen: 1, J: 0, maxR: 0,
      });
    }
    let pulsesEnabled = true;
    let pulseWrite = 0;

    // -----------------------------------------------------------------------
    // (c) 拖拽沉降状态（同一时刻只有一个）
    // -----------------------------------------------------------------------
    let settle = null;

    // -----------------------------------------------------------------------
    // 计数（用于空闲判定）
    // -----------------------------------------------------------------------
    let popCount = 0;
    let fadeCount = 0;

    const fx = {
      get popCount() { return popCount; },
      get fadeCount() { return fadeCount; },
      get settleActive() { return settle !== null; },
    };

    // =======================================================================
    // 揭示 / 隐藏
    // =======================================================================
    /**
     * @param {number} i 节点索引
     * @param {number} delay 延迟秒数（径向错峰用；负数/0 表示立即）
     */
    fx.beginReveal = function beginReveal(i, delay) {
      if (i < 0 || i >= n) return;
      D.visible[i] = 1;
      D.wantVisible[i] = 1;
      // ⚠ popCount 是 updatePops 的【早退依据】，必须恰好等于激活的 pop 数。
      //   同一个节点在 pop 结束前又被 reveal 一次是真实存在的路径（先淡出到
      //   不可见、再被揭示回来），无条件 ++ 会让计数只增不减 ——
      //   那样早退永远不生效，等于白加了一个守卫。
      if (D.popT[i] !== D.popT[i]) popCount++;
      D.popT[i] = -Math.max(0, delay || 0);   // 负数 = 延迟倒计时中
      D.popDur[i] = popDuration();
      D.scaleMul[i] = 1;
      D.renderAlpha[i] = 0;                   // 由 pop 的时间轴负责渐入
      D.simWeight[i] = 0;                     // 权重渐入，避免突然给邻居一个力
      // 这里会直接清掉进行中的淡出（时间轴走的是 cancelHide 那条路，到不了这里），
      // 但既然清了就得把 fadeCount 一并还回去 —— 否则它会只增不减，
      // updateFades 的早退守卫就永远失效。
      if (D.fadeT[i] === D.fadeT[i]) fadeCount--;
      D.fadeT[i] = NaN;
    };

    fx.beginHide = function beginHide(i) {
      if (i < 0 || i >= n) return;
      if (D.fadeT[i] === D.fadeT[i] && D.fadeT[i] >= 0) return;   // 已在淡出
      D.fadeT[i] = 0;
      D.fadeFrom[i] = D.simWeight[i];
      fadeCount++;
    };

    /**
     * 撤销进行中的淡出。
     * 来回拖时间轴滑块时，一个节点可能"刚被隐藏 → 立刻又被要求显示"。
     * 不处理这种情况的话它会继续淡出到不可见并【卡死在那里】——
     * 因为 fadeT 走完会把 visible 置 0，而这次 cutoff 变化已经处理过了，
     * 没有后续事件会再把它揭示出来。
     */
    fx.cancelHide = function cancelHide(i) {
      if (i < 0 || i >= n) return false;
      if (D.fadeT[i] !== D.fadeT[i]) return false;    // 没在淡出
      D.fadeT[i] = NaN;
      D.renderAlpha[i] = 1;
      D.scaleMul[i] = 1;
      D.simWeight[i] = D.fadeFrom[i] > 0 ? D.fadeFrom[i] : 1;
      fadeCount = Math.max(0, fadeCount - 1);
      return true;
    };

    // =======================================================================
    // 激波
    // =======================================================================
    /**
     * @param {object} o { ox, oy, magnitude, sign, viewportWorldHeight }
     *   sign > 0 前进（把旧节点推开）；sign < 0 倒退（把节点向内吸 → 内爆）
     */
    fx.pulse = function pulse(o) {
      if (!pulsesEnabled) return;
      o = o || {};
      const sc = cfg.shock;

      // 反缩放第 ⑤ 条：总位移上限。
      // 阻尼系统的位移 ≈ v0 / 衰减率。velocityRetain=0.94 → 每秒衰减 -ln(0.94)·60 ≈ 3.71
      let mag = Math.abs(o.magnitude !== undefined ? o.magnitude : sc.magnitude);
      const vh = o.viewportWorldHeight;
      if (vh > 0) {
        const decayRate = Math.max(0.5, -Math.log(clamp(cfg.physics.velocityRetain, 0.5, 0.999)) * 60);
        const maxMag = (sc.maxDisplacementRatio * vh * decayRate);
        if (mag > maxMag) mag = maxMag;      // 整体缩放，【不要逐节点截断】—— 那会把剖面削成台阶
      }
      if (mag <= 0) return;

      const p = pulses[pulseWrite];
      pulseWrite = (pulseWrite + 1) % poolSize;   // 池满时覆盖最旧的那个

      p.active = true;
      p.ox = o.ox || 0;
      p.oy = o.oy || 0;
      p.r0 = o.r0 || 0;
      p.rPrev = p.r0;
      p.rCur = p.r0;
      p.speed = sc.speed;
      p.decayLen = sc.decayLen;
      // 行程：默认按图谱尺寸算，扫完就结束，不会空跑（见 config.shock.maxRadiusFactor）
      p.maxR = Math.min(sc.maxRadius, o.maxRadius || sc.maxRadius);
      p.J = mag * (o.sign < 0 ? sc.backwardSign : 1);
    };

    fx.setPulsesEnabled = function setPulsesEnabled(b) { pulsesEnabled = !!b; };
    fx.clearPulses = function clearPulses() {
      for (let i = 0; i < poolSize; i++) pulses[i].active = false;
    };

    // =======================================================================
    // 拖拽沉降
    // =======================================================================
    /**
     * 闭式欠阻尼振子。参数沿用 v1 已经调好的值。
     *   x(t) = target + e^(−ζω₀t)·(cA·cos(ω_d t) + cB·sin(ω_d t))
     *   cA = x0,  cB = (v0 + ζω₀·x0) / ω_d
     */
    fx.startSettle = function startSettle(i, releaseX, releaseY, velX, velY, targetX, targetY, camK) {
      const d = cfg.drag;
      const w0 = d.elasticStiffness;
      const zeta = d.jellyDamping;
      const wd = w0 * Math.sqrt(Math.max(0, 1 - zeta * zeta)) || 1e-4;

      const x0 = releaseX - targetX;
      const y0 = releaseY - targetY;

      // 名义沉降时长 ≈ 3/(ζω₀)。
      // 硬 pin 会让节点被钉在一条布局不同意的轨迹上，交接瞬间累积的分歧会以"啪"的一下释放。
      // 改为最后一段把控制权按权重交还模拟 —— w=0 时节点速度已经是"模拟合理"的，无不连续。
      const tNom = clamp(3 / Math.max(0.001, zeta * w0), 0.3, d.maxSettleTime);

      settle = {
        i,
        targetX, targetY,
        cAx: x0, cAy: y0,
        cBx: (velX + zeta * w0 * x0) / wd,
        cBy: (velY + zeta * w0 * y0) / wd,
        w0, zeta, wd,
        t: 0,
        tNom,
        blendFrom: tNom * 0.55,
        // 收敛阈值原来是 px，这里按相机缩放换成世界单位
        stopVel: 0.12 / Math.max(0.05, camK),
        stopDist: 0.4 / Math.max(0.05, camK),
      };
    };

    fx.cancelSettle = function cancelSettle() { settle = null; };

    /**
     * 在 sim.tick() 【之后】调用。此刻 D.x/vx 是模拟积分的结果。
     * 把模拟结果与解析解按权重混合：w=1 全解析，w=0 全模拟。
     */
    fx.applyHandoff = function applyHandoff(dt) {
      if (!settle) return;
      const s = settle;
      const i = s.i;
      s.t += dt;

      const decay = Math.exp(-s.zeta * s.w0 * s.t);
      const cosT = Math.cos(s.wd * s.t);
      const sinT = Math.sin(s.wd * s.t);

      const xAna = s.targetX + decay * (s.cAx * cosT + s.cBx * sinT);
      const yAna = s.targetY + decay * (s.cAy * cosT + s.cBy * sinT);

      // 解析解的速度（导数）
      const dDecay = -s.zeta * s.w0 * decay;
      const vxAna = dDecay * (s.cAx * cosT + s.cBx * sinT) + decay * (-s.cAx * s.wd * sinT + s.cBx * s.wd * cosT);
      const vyAna = dDecay * (s.cAy * cosT + s.cBy * sinT) + decay * (-s.cAy * s.wd * sinT + s.cBy * s.wd * cosT);

      // 权重：前 55% 全解析，之后线性交还给模拟
      const w = s.t <= s.blendFrom
        ? 1
        : clamp(1 - (s.t - s.blendFrom) / Math.max(0.0001, s.tNom - s.blendFrom), 0, 1);

      const xSim = D.x[i], ySim = D.y[i];
      const vxSim = D.vx[i], vySim = D.vy[i];

      D.x[i] = xSim * (1 - w) + xAna * w;
      D.y[i] = ySim * (1 - w) + yAna * w;
      // 解析解的速度是 wu/s，模拟内部是 wu/tick —— 加权前先换算
      D.vx[i] = vxSim * (1 - w) + vxAna * DT * w;
      D.vy[i] = vySim * (1 - w) + vyAna * DT * w;

      const dist = Math.hypot(xAna - s.targetX, yAna - s.targetY);
      const speed = Math.hypot(vxAna, vyAna);

      // 收敛判定（沿用 v1 的条件）+ w 归零 + 硬超时
      if (w <= 0 || (s.t > 0.20 && speed < s.stopVel && dist < s.stopDist) || s.t > cfg.drag.maxSettleTime) {
        settle = null;
        sim.reheat(cfg.reheat.dragRelease);
      }
    };

    // =======================================================================
    // 每帧推进
    // =======================================================================
    fx.update = function update(dt) {
      updatePops(dt);
      updateFades(dt);
      updatePulses(dt);
    };

    function updatePops(dt) {
      // 空转剪枝：下面是 O(n) 全表扫描，而绝大多数帧里一个在弹的节点都没有
      // （图谱沉降完之后 popCount 恒为 0）。不剪的话每个 substep 白扫一遍 n ——
      // 3000 节点 × 每帧 3 个 substep 就是 9000 次无效迭代。
      // 计数器的精确性由 beginReveal（去重 ++）/ updatePops（--）配对保证。
      if (popCount <= 0) return;

      const { amp, omega, zeta, fadeInTime, simWeightRamp } = cfg.pop;
      const decayRate = Math.max(0.0001, zeta * omega);
      const wd = omega * Math.sqrt(Math.max(0, 1 - zeta * zeta));
      const rampTime = Math.max(0.001, simWeightRamp);

      const popT = D.popT, popDur = D.popDur, scaleMul = D.scaleMul,
        renderAlpha = D.renderAlpha, simWeight = D.simWeight, fadeT = D.fadeT;
      // 只触碰激活的节点 —— 通常是几十到几百个
      for (let i = 0; i < n; i++) {
        let t = popT[i];
        if (t !== t) continue;                    // NaN = 未激活

        // 正在淡出的节点由 updateFades 独占 scaleMul / renderAlpha / simWeight。
        // 两个动画同时写这三个数组会互相覆盖，而且 pop 的收尾分支会把 simWeight
        // 推回 1 —— 于是一个【看不见却仍然留在模拟里】的节点出现了：它照样进
        // activeMask、照样对邻居施力，永远不退场。所以 pop 在这里让位，
        // 并把自己从计数里摘掉（必须摘，否则早退守卫永远失效）。
        if (fadeT[i] === fadeT[i]) { popT[i] = NaN; popCount--; continue; }

        if (t < 0) {                              // 延迟倒计时
          t += dt;
          if (t < 0) { popT[i] = t; continue; }
          popT[i] = 0;
          // 延迟期间保持不可见；到点了才开始渐入
        }

        const elapsed = t + dt;
        popT[i] = elapsed;

        const e = Math.exp(-decayRate * elapsed);
        scaleMul[i] = 1 + amp * e * Math.sin(wd * elapsed);
        renderAlpha[i] = clamp(elapsed / Math.max(0.001, fadeInTime), 0, 1);
        // 力的权重渐入。不做这一步的话节点永远进不了网格，也就永远画不出来。
        simWeight[i] = clamp(elapsed / rampTime, 0, 1);

        if (elapsed >= popDur[i]) {
          popT[i] = NaN;
          scaleMul[i] = 1;
          renderAlpha[i] = 1;
          simWeight[i] = 1;
          popCount--;
        }
      }
    }

    function updateFades(dt) {
      // 同 updatePops 的空转剪枝。fadeCount 的配对：beginHide（已在淡出则提前
      // return）/ cancelHide / 这里的收尾分支，三者正好覆盖全部增减路径。
      if (fadeCount <= 0) return;

      const fadeTime = Math.max(0.001, cfg.timeline.hideFadeTime);
      const shrink = cfg.timeline.hideShrink;
      const fadeT = D.fadeT, renderAlpha = D.renderAlpha, simWeight = D.simWeight,
        scaleMul = D.scaleMul, visible = D.visible;

      for (let i = 0; i < n; i++) {
        let t = fadeT[i];
        if (t !== t) continue;                    // NaN = 未激活

        t += dt / fadeTime;
        if (t >= 1) {
          fadeT[i] = NaN;
          visible[i] = 0;
          simWeight[i] = 0;
          renderAlpha[i] = 0;
          fadeCount--;
          continue;
        }
        fadeT[i] = t;
        renderAlpha[i] = 1 - t;
        simWeight[i] = D.fadeFrom[i] * (1 - t);
        // 缩小着消失比原地淡出好看
        scaleMul[i] = 1 - (1 - shrink) * t;
      }
    }

    function updatePulses(dt) {
      if (!pulsesEnabled) return;
      const sc = cfg.shock;

      for (let pi = 0; pi < poolSize; pi++) {
        const p = pulses[pi];
        if (!p.active) continue;

        p.rPrev = p.rCur;
        p.rCur += p.speed * dt;
        if (p.rCur > (p.maxR || sc.maxRadius)) { p.active = false; continue; }

        // 线性扫描。用网格只查环带理论上更好，但环带很薄，
        // 且激波是短时事件（~1s），线性扫描在 3000 节点下约 0.1ms/帧，不值得复杂化。
        const ox = p.ox, oy = p.oy, rPrev = p.rPrev, rCur = p.rCur;
        const J = p.J, decayLen = p.decayLen, r0 = p.r0;
        const jit = sc.jitter, mf = sc.massFactor;

        for (let i = 0; i < n; i++) {
          if (D.simWeight[i] === 0 || !D.visible[i]) continue;
          if (D.pinMode[i] === GFI.Physics.PIN_HARD) continue;   // 别把用户正拖着的节点打飞

          const dx = D.x[i] - ox, dy = D.y[i] - oy;
          const d2 = dx * dx + dy * dy;
          if (d2 > rCur * rCur) continue;                        // 波前还没到（或已远超）
          const d = Math.sqrt(d2) || 1e-3;
          if (d < rPrev || d >= rCur) continue;                  // 只在本帧的环带内 —— 保证恰好击中一次

          const jitF = 1 + jit * (hash11s(i, 3) - 0.5);
          const massScale = 1 / (1 + mf * Math.sqrt(D.deg[i]));
          const mag = J * Math.exp(-(d - r0) / decayLen) * jitF * massScale;

          // mag 是 wu/s 的冲量幅值；乘 DT 换算成模拟内部的 wu/tick
          const inv = mag * DT / d;
          D.vx[i] += dx * inv;
          D.vy[i] += dy * inv;
        }
      }
    }

    fx.anyActive = function anyActive() {
      return popCount > 0 || fadeCount > 0 || settle !== null || pulsesActive();
    };

    function pulsesActive() {
      for (let i = 0; i < poolSize; i++) if (pulses[i].active) return true;
      return false;
    }
    // 供时间轴判断"上一道波走完了没有"
    fx.pulsesActive = pulsesActive;

    fx.reset = function reset() {
      D.popT.fill(NaN, 0, n);
      D.fadeT.fill(NaN, 0, n);
      D.scaleMul.fill(1, 0, n);
      D.renderAlpha.fill(1, 0, n);
      D.simWeight.fill(1, 0, n);
      popCount = 0; fadeCount = 0;
      settle = null;
      fx.clearPulses();
    };

    fx.destroy = function destroy() {
      settle = null;
      fx.clearPulses();
    };

    return fx;
  }

  GFI.Effects = { create };
})(window.GFI);
