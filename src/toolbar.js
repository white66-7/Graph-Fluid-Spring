/*
 * GFI.Toolbar — 紧凑控件栏
 * ===========================================================================
 * 只保留四个东西：
 *   ▶/⏸  播放暂停 | 日期 + 时间滑块 | 类型开关(页面/标签/日记) | ⤢ 适配视野
 *
 * 已移除（按需求精简）：倍速切换、循环开关、回到现在、切换原生图谱。
 *   倍速 → 设置面板的「基础演变周期」
 *   回到现在 → 把滑块拖到最右即可
 *   原生图谱 → 插件设置里的「使用原生图谱」开关，或 __GFI__.native(true)
 *
 * 用原生 DOM 而不是 React：我们在宿主 document 里，拿不到插件 iframe 的 React 实例，
 * 而且这点 UI 用原生 DOM 更简单、更容易精确销毁。
 */
(function (GFI) {
  'use strict';
  if (GFI.Toolbar) return;

  const SVG = {
    play: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4v16l13-8z"/></svg>',
    pause: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg>',
    fit: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/></svg>',
  };

  function fmtDate(ms) {
    const d = new Date(ms);
    const p = (v) => String(v).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /**
   * @param {HTMLElement} host .gfi-toolbar 容器
   * @param {object} hooks { onTogglePlay, onScrub(value01), onScrubEnd, onToggleKind(idx), onFit }
   */
  function create(host, hooks) {
    const doc = GFI.topDoc;
    hooks = hooks || {};
    const made = [];

    function el(tag, cls, html) {
      const n = doc.createElement(tag);
      if (cls) n.className = cls;
      if (html !== undefined) n.innerHTML = html;
      host.appendChild(n);
      made.push(n);
      return n;
    }

    function button(title, html, cls) {
      const b = el('button', 'gfi-btn' + (cls ? ' ' + cls : ''), html);
      b.title = title;
      b.setAttribute('aria-label', title);
      return b;
    }

    // ---- 时间旅行组（无时间戳时整组收起）----
    const timeWrap = el('div', 'gfi-time');

    const playBtn = doc.createElement('button');
    playBtn.className = 'gfi-btn';
    playBtn.title = '播放 / 暂停时间演变';
    playBtn.setAttribute('aria-label', '播放 / 暂停时间演变');
    playBtn.innerHTML = SVG.play;
    timeWrap.appendChild(playBtn);
    made.push(playBtn);

    const label = doc.createElement('span');
    label.className = 'gfi-label';
    label.textContent = '';        // 由 syncToolbar 填标准日期
    timeWrap.appendChild(label);
    made.push(label);

    const slider = doc.createElement('input');
    slider.type = 'range';
    slider.className = 'gfi-slider';
    slider.min = '0';
    slider.max = '1000';
    slider.step = '1';
    slider.value = '1000';
    timeWrap.appendChild(slider);
    made.push(slider);

    // ---- 类型开关 ----
    // 用短文字而不是图标：这三个概念没有公认的图标，硬凑反而难认。
    // 二字标签已经是"最低限度文字"的极限了。
    el('div', 'gfi-sep');
    const KINDS = [
      { idx: 0, label: '页面' },
      { idx: 1, label: '标签' },
      { idx: 2, label: '日记' },
    ];
    const kindBtns = KINDS.map((k) => {
      const b = button(`显示 / 隐藏${k.label}`, k.label, 'gfi-kind');
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (hooks.onToggleKind) hooks.onToggleKind(k.idx);
      });
      return b;
    });

    // ---- 适配视野 ----
    el('div', 'gfi-sep');
    const fitBtn = button('适配视野', SVG.fit);

    // ---- 事件 ----
    let scrubbing = false;

    playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (hooks.onTogglePlay) hooks.onTogglePlay();
    });
    fitBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (hooks.onFit) hooks.onFit();
    });

    slider.addEventListener('pointerdown', (e) => { e.stopPropagation(); scrubbing = true; });
    slider.addEventListener('input', (e) => {
      e.stopPropagation();
      if (hooks.onScrub) hooks.onScrub(Number(slider.value) / 1000);
    });
    const endScrub = (e) => {
      if (e) e.stopPropagation();
      if (!scrubbing) return;
      scrubbing = false;
      if (hooks.onScrubEnd) hooks.onScrubEnd();
    };
    slider.addEventListener('pointerup', endScrub);
    slider.addEventListener('pointercancel', endScrub);
    slider.addEventListener('change', endScrub);

    // 阻止事件冒泡到 #global-graph，避免被 Logseq 自己的处理器捡走
    ['pointerdown', 'pointerup', 'click', 'wheel'].forEach((t) => {
      host.addEventListener(t, (e) => e.stopPropagation());
    });

    const api = {
      setPlaying(p) { playBtn.innerHTML = p ? SVG.pause : SVG.play; },

      setProgress(p) {
        const v = Math.round(Math.max(0, Math.min(1, p)) * 1000);
        // 拖动中不要回写 value —— 会跟用户的手抢
        if (!scrubbing) slider.value = String(v);
        slider.style.setProperty('--gfi-progress', (v / 10).toFixed(2) + '%');
      },

      setLabel(text) { label.textContent = text; },

      /** @param {number[]} onFlags 长度 3，对应 页面/标签/日记 */
      setKinds(onFlags) {
        kindBtns.forEach((b, i) => b.classList.toggle('gfi-active', !!onFlags[i]));
      },

      setTimeTravelAvailable(available) {
        timeWrap.style.display = available ? '' : 'none';
      },

      fmtDate,
      destroy() {
        for (const n of made) { try { n.remove(); } catch (e) {} }
        made.length = 0;
      },
    };

    return api;
  }

  GFI.Toolbar = { create, fmtDate };
})(window.GFI);
