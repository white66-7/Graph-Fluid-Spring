/*
 * GFI — 命名空间与基础工具
 * ===========================================================================
 * 必须最先加载。
 *
 * 命名空间挂在【插件 iframe 自己的 window】上，不挂 top：
 *   挂 top 会和宿主页面、以及其他插件的全局变量冲突。
 *   只有 DOM、计时器、Observer 走 topWin / topDoc。
 *
 * 为什么 DOM/计时必须走 top：
 *   Logseq 插件 iframe 经常是 display:none 或零尺寸的，
 *   隐藏 iframe 的 requestAnimationFrame 永不触发 —— 渲染循环会静默死掉。
 */
(function () {
  'use strict';

  const GFI = (window.GFI = window.GFI || {});
  if (GFI.__nsReady) return;   // 防重复求值（Logseq 可能重载 iframe）
  GFI.__nsReady = true;

  GFI.VERSION = '2.0.0';

  // 固定仿真步长。速度的单位是「世界单位 / tick」，各力直接往速度上累加，
  // 不额外乘 dt —— 这是 d3-force 的离散约定，好处是 d3 的力常数可以直接搬。
  // 需要以「世界单位 / 秒」表达的场合（激波冲量、拖拽甩掷速度）在边界处乘以它换算。
  GFI.DT = 1 / 60;

  // -------------------------------------------------------------------------
  // 宿主窗口 / 文档
  // -------------------------------------------------------------------------
  let topWin = window;
  let topDoc = null;
  try {
    if (window.parent && window.parent !== window) {
      topWin = window.parent;
      topDoc = topWin.document;
    } else {
      topDoc = window.document;
    }
  } catch (e) {
    // 跨域等异常 —— 退回自身
    topWin = window;
    topDoc = window.document;
  }
  GFI.topWin = topWin;
  GFI.topDoc = topDoc;

  // -------------------------------------------------------------------------
  // 数学工具
  // -------------------------------------------------------------------------
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const lerp = (a, b, t) => a + (b - a) * t;

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  // 确定性整数哈希 → [0,1)。用于每节点稳定抖动（不能每帧变，否则会闪）
  function hash11(i) {
    let x = Math.imul((i | 0) ^ 0x9e3779b9, 0x85ebca6b);
    x ^= x >>> 13;
    x = Math.imul(x, 0xc2b2ae35);
    x ^= x >>> 16;
    return (x >>> 0) / 4294967296;
  }

  // 带种子的变体 —— 同一节点需要多条互不相关的抖动流时用
  function hash11s(i, seed) {
    return hash11((i | 0) * 374761393 + (seed | 0) * 668265263);
  }

  const now = () => topWin.performance.now();

  // 对称随机偏移 [-a, +a)，由 hash 驱动，可复现
  const jitter = (i, seed, a) => (hash11s(i, seed) - 0.5) * 2 * a;

  // -------------------------------------------------------------------------
  // 微型事件总线
  // -------------------------------------------------------------------------
  function createEmitter() {
    const map = new Map();
    return {
      on(evt, cb) {
        let set = map.get(evt);
        if (!set) map.set(evt, (set = new Set()));
        set.add(cb);
        return () => set.delete(cb);
      },
      off(evt, cb) {
        const set = map.get(evt);
        if (set) set.delete(cb);
      },
      emit(evt, payload) {
        const set = map.get(evt);
        if (!set || !set.size) return;
        // 复制一份再遍历：回调里可能 off 掉自己
        for (const cb of Array.from(set)) {
          try { cb(payload); } catch (e) { console.error('[GFI] listener error', evt, e); }
        }
      },
      clear() { map.clear(); },
    };
  }

  // -------------------------------------------------------------------------
  // 监听器登记表 —— 保证 teardown 时一个不漏
  // -------------------------------------------------------------------------
  function createListenerRegistry() {
    const entries = [];
    return {
      add(target, type, fn, opts) {
        if (!target || typeof target.addEventListener !== 'function') return;
        target.addEventListener(type, fn, opts);
        entries.push([target, type, fn, opts]);
      },
      removeAll() {
        for (const [target, type, fn, opts] of entries) {
          try { target.removeEventListener(type, fn, opts); } catch (e) {}
        }
        entries.length = 0;
      },
      get size() { return entries.length; },
    };
  }

  // -------------------------------------------------------------------------
  // 颜色
  // -------------------------------------------------------------------------
  // '#rrggbb' → [r,g,b]
  function hexToRgb(hex) {
    const h = hex.charCodeAt(0) === 35 ? hex.slice(1) : hex;
    const v = parseInt(h.length === 3
      ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
      : h, 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  // 把 '#rrggbb' 预转成 'rgba(r,g,b,' 前缀，配 globalAlpha 用，避免每帧拼字符串
  function rgbaPrefix(hex) {
    const [r, g, b] = hexToRgb(hex);
    return `rgba(${r},${g},${b},`;
  }

  // -------------------------------------------------------------------------
  // 导出
  // -------------------------------------------------------------------------
  GFI.util = {
    clamp, clamp01, lerp, hash11, hash11s, jitter, now,
    hexToRgb, rgbaPrefix,
    createEmitter, createListenerRegistry,
  };
})();
