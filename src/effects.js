(function (GFI) {
  'use strict';
  if (GFI.Effects) return;

  const { clamp } = GFI.util;

  function create(D) {
    const n = D.n;
    const cfg = GFI.config;

    // 缓动常量
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

    // 出生动画时长
    function popDuration() {
      return Math.log(1 - OBS_DONE) / Math.log(OBS_KEEP) / 60;   // ≈ 0.729 秒
    }

    // 活跃索引列表
    const popList = new Int32Array(n);
    const fadeList = new Int32Array(n);
    let popN = 0, fadeN = 0;

    const fx = {
      get popCount() { return popN; },
      get fadeCount() { return fadeN; },
    };

    // 揭示 / 隐藏
    fx.beginReveal = function beginReveal(i) {
      if (i < 0 || i >= n) return;
      D.visible[i] = 1;
      D.wantVisible[i] = 1;

      if (D.popT[i] !== D.popT[i]) popList[popN++] = i;
      D.popT[i] = 0;
      // 尺寸不变
      D.scaleMul[i] = 1;
      // 透明度
      D.renderAlpha[i] = 0;

      // 受力权重从 0 渐入
      D.simWeight[i] = ramp > 0 ? 0 : 1.0;

      if (D.fadeT[i] === D.fadeT[i]) {
        // 复活正在淡出的节点
        for (let k = 0; k < fadeN; k++) {
          if (fadeList[k] === i) { fadeList[k] = fadeList[--fadeN]; break; }
        }
      }
      // 撤销淡出
      D.fadeT[i] = NaN;
    };

    // 节点淡出
    fx.beginHide = function beginHide(i) {
      if (i < 0 || i >= n) return;
      if (D.fadeT[i] === D.fadeT[i] && D.fadeT[i] >= 0) return;
      D.fadeT[i] = 0;
      D.fadeFrom[i] = D.simWeight[i];
      fadeList[fadeN++] = i;
    };

    // 撤销淡出
    fx.cancelHide = function cancelHide(i) {
      if (i < 0 || i >= n) return false;
      if (D.fadeT[i] !== D.fadeT[i]) return false;
      D.fadeT[i] = NaN;
      D.renderAlpha[i] = 1;
      D.scaleMul[i] = 1;
      D.simWeight[i] = D.fadeFrom[i];
      for (let k = 0; k < fadeN; k++) {
        if (fadeList[k] === i) { fadeList[k] = fadeList[--fadeN]; break; }
      }
      return true;
    };

    // 瞬时隐藏 
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

      const popT = D.popT, scaleMul = D.scaleMul,
        renderAlpha = D.renderAlpha, simWeight = D.simWeight, fadeT = D.fadeT;

      let j = 0;
      // 遍历每个正在出生的节点
      while (j < popN) {
        const i = popList[j];
        const t = popT[i];

        // 不变量自愈：正常路径不该走到这（摘列表的地方都该同步清 popT）
        if (t !== t || fadeT[i] === fadeT[i]) {
          if (t === t) popT[i] = NaN;
          popList[j] = popList[--popN];
          continue;
        }

        // 一阶指数逼近
        const a = renderAlpha[i] * OBS_KEEP + (1 - OBS_KEEP);
        renderAlpha[i] = a;
        scaleMul[i] = 1;

        if (rampTime > 0 && simWeight[i] < 1) {
          const w = simWeight[i] + dt / rampTime;
          simWeight[i] = w > 1 ? 1 : w;
        }

        // 完成后清除标记
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

        if (t !== t) {
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

    // 诊断
    fx.popDuration = popDuration;

    // 一键归零
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