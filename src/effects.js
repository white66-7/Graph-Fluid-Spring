(function (GFI) {
  'use strict';
  if (GFI.Effects) return;

  const { clamp} = GFI.util;

  function create(D) {
    const n = D.n;
    const cfg = GFI.config;

    // Obsidian 缓动常量
    const OBS_KEEP = 0.9;   
    const OBS_DONE = 0.99;     


    const rawRate = Number(cfg.timeline.revealRate);
    let rate;
    if (rawRate === 0) {
      rate = clamp(0.5 * Math.sqrt(D.m), 5, 100);   // 自动模式
    } else {
      rate = clamp(rawRate || 1, 0.05, 200);
    }
    const ramp = rate >= 1
      ? (cfg.pop.simWeightRampFast || 0.3)
      : (cfg.pop.simWeightRampSlow || 1.0);


    function popDuration() {
      return Math.log(1 - OBS_DONE) / Math.log(OBS_KEEP) / 60;   // ≈ 0.729 秒
    }



    // -----------------------------------------------------------------------
    // 计数（用于空闲判定）
    // -----------------------------------------------------------------------
    // 🌟 T3 活跃索引列表：pop/fade 的逐帧推进从「全表 O(n) 扫描」改成「只扫活跃项」。
    //   播放期间 popCount 几乎恒 >0，旧实现对 5000 节点图是每帧几千次无效分支。
    //   popN/fadeN 是唯一事实来源，popCount/fadeCount 变成它们的只读别名 ——
    //   对外 getter、anyActive、§10 的计数器断言语义全部不变。
    //   ⚠ 不变量：列表里的每个 i 必有 popT[i]（fadeT[i]）为数字 —— 所有把
    //   T 置回 NaN 的路径（自然结束 / cancelHide / 被隐藏打断）都必须同步摘除。
    const popList = new Int32Array(n);
    const fadeList = new Int32Array(n);
    let popN = 0, fadeN = 0;

    const fx = {
      get popCount() { return popN; },
      get fadeCount() { return fadeN; },
    };

    // =======================================================================
    // 揭示 / 隐藏
    // =======================================================================
    fx.beginReveal = function beginReveal(i, delay) {
      if (i < 0 || i >= n) return;
      D.visible[i] = 1;
      D.wantVisible[i] = 1;

      if (D.popT[i] !== D.popT[i]) popList[popN++] = i;
      D.popT[i] = -Math.max(0, delay || 0);
      // ⚠ popDur 是「这个节点在活跃列表里待多久」，不是「动画多长」。
      //   受力权重渐入（simWeightRamp）可能比动画还长 —— 必须先待够，
      //   否则节点被移出活跃列表后渐入就永远走不完。
      //   实测：动画 0.729s、ramp 0.9s 时，200 个节点的 simWeight 卡在 0.81 不再上升。
      D.popDur[i] = Math.max(popDuration(), ramp);
      D.scaleMul[i] = 1;
      D.renderAlpha[i] = 0;

      // 🌟 受力权重：默认【从 0 渐入】（config.pop.simWeightRamp）。
      //   新节点落在邻居质心上、斥力又是恒定幅值 —— 首帧全开等于给邻居一记闷棍，
      //   实测一半冲量挤在头 3 帧。渐入把它摊到半秒，总冲量不变、照样落位。
      //   ramp = 0 时保留旧的「首帧全受力」。
      D.simWeight[i] = ramp > 0 ? 0 : 1.0;

      if (D.fadeT[i] === D.fadeT[i]) {
        // 复活一个正在淡出的节点 → 从活跃列表摘除，fadeT 同步清掉
        for (let k = 0; k < fadeN; k++) {
          if (fadeList[k] === i) { fadeList[k] = fadeList[--fadeN]; break; }
        }
      }
      D.fadeT[i] = NaN;
    };

    fx.beginHide = function beginHide(i) {
      if (i < 0 || i >= n) return;
      if (D.fadeT[i] === D.fadeT[i] && D.fadeT[i] >= 0) return;
      D.fadeT[i] = 0;
      D.fadeFrom[i] = D.simWeight[i];
      fadeList[fadeN++] = i;
    };

    fx.cancelHide = function cancelHide(i) {
      if (i < 0 || i >= n) return false;
      if (D.fadeT[i] !== D.fadeT[i]) return false;
      D.fadeT[i] = NaN;
      D.renderAlpha[i] = 1;
      D.scaleMul[i] = 1;
      D.simWeight[i] = D.fadeFrom[i] > 0 ? D.fadeFrom[i] : 1;
      for (let k = 0; k < fadeN; k++) {
        if (fadeList[k] === i) { fadeList[k] = fadeList[--fadeN]; break; }
      }
      return true;
    };

    // 🌟 瞬时隐藏 —— beginHide 的「不等淡出」版本：直接落到淡出走完那一帧的状态
    //   （= updateFades 里 t >= 1 分支的四个赋值），并把该节点从 pop/fade 两个
    //   活跃列表里摘掉（见文件内不变量注释：列表成员必须 T 为数字）。
    //
    //   为什么需要它：时间轴「重新开始播放」时要把整张图倒回空白，而 beginHide
    //   是【动画】—— 节点要 0.26 秒才真的 visible=0。这期间它们仍是 visible=1，
    //   于是紧接着的下一帧揭示会全部命中 setCutoff 的 cancelHide 分支，
    //   等于绕过了逐帧揭示额度，一帧把整簇放回来。倒带语义上本来就不该有淡出。
    fx.hideNow = function hideNow(i) {
      if (i < 0 || i >= n) return;
      if (D.fadeT[i] === D.fadeT[i]) {
        for (let k = 0; k < fadeN; k++) {
          if (fadeList[k] === i) { fadeList[k] = fadeList[--fadeN]; break; }
        }
      }
      if (D.popT[i] === D.popT[i]) {
        for (let k = 0; k < popN; k++) {
          if (popList[k] === i) { popList[k] = popList[--popN]; break; }
        }
      }
      D.fadeT[i] = NaN;
      D.popT[i] = NaN;
      D.visible[i] = 0;
      D.simWeight[i] = 0;
      D.renderAlpha[i] = 0;
      D.scaleMul[i] = 1;
    };

    // 每帧推进出生/淡出/脉冲的动画进度
    fx.update = function update(dt) {
      updatePops(dt);
      updateFades(dt);
    };

    function updatePops(dt) {
      if (popN <= 0) return;
      const rampTime = ramp;

      const popT = D.popT, popDur = D.popDur, scaleMul = D.scaleMul,
        renderAlpha = D.renderAlpha, simWeight = D.simWeight, fadeT = D.fadeT;

      let j = 0;
      while (j < popN) {
        const i = popList[j];
        const t = popT[i];

        if (t !== t || fadeT[i] === fadeT[i]) {
          if (t === t) popT[i] = NaN;
          popList[j] = popList[--popN];
          continue;
        }

        if (t < 0) {
          const t2 = t + dt;
          if (t2 < 0) { popT[i] = t2; j++; continue; }
          popT[i] = 0;
        }

        const elapsed = popT[i] + dt;
        popT[i] = elapsed;

        // 纯淡入
        const a = renderAlpha[i] * OBS_KEEP + (1 - OBS_KEEP);
        renderAlpha[i] = a;
        scaleMul[i] = 1;

        if (rampTime > 0 && simWeight[i] < 1) {
          const w = simWeight[i] + dt / rampTime;
          simWeight[i] = w > 1 ? 1 : w;
        }

        if (a >= OBS_DONE && simWeight[i] >= 1) {
          popT[i] = NaN;
          renderAlpha[i] = 1;
          popList[j] = popList[--popN];
          continue;
        }
        j++;
      }
    }


    function updateFades(dt) {
      if (fadeN <= 0) return;

      const fadeTime = Math.max(0.001, cfg.timeline.hideFadeTime);
      const shrink = cfg.timeline.hideShrink;
      const fadeT = D.fadeT, renderAlpha = D.renderAlpha, simWeight = D.simWeight,
        scaleMul = D.scaleMul, visible = D.visible;

      let j = 0;
      while (j < fadeN) {
        const i = fadeList[j];
        let t = fadeT[i];

        if (t !== t) {                   // 不变量自愈（正常路径 cancelHide 已摘除）
          fadeList[j] = fadeList[--fadeN];
          continue;
        }

        t += dt / fadeTime;
        if (t >= 1) {
          fadeT[i] = NaN;
          visible[i] = 0;
          simWeight[i] = 0;
          renderAlpha[i] = 0;
          fadeList[j] = fadeList[--fadeN];
          continue;
        }
        fadeT[i] = t;
        renderAlpha[i] = 1 - t;
        simWeight[i] = D.fadeFrom[i] * (1 - t);
        scaleMul[i] = 1 - (1 - shrink) * t;
        j++;
      }
    }

    fx.anyActive = function anyActive() {
      return popN > 0 || fadeN > 0;
    };

    // 暴露给诊断用：单次出生动画的实际秒数。
    // 它 × 诞生速率 = 「同一时刻有几个节点正在做出生动画」—— 这才是「密度」，
    // 只看「每秒几个节点」会漏掉动画时长这一半（__GFI__.tlState() 用它算）。
    fx.popDuration = popDuration;

    fx.reset = function reset() {
      D.popT.fill(NaN, 0, n);
      D.fadeT.fill(NaN, 0, n);
      D.scaleMul.fill(1, 0, n);
      D.renderAlpha.fill(1, 0, n);
      D.simWeight.fill(1, 0, n);
      popN = 0; fadeN = 0;
    };

    fx.destroy = function destroy() {
    };

    return fx;
  }

  GFI.Effects = { create };
})(window.GFI);