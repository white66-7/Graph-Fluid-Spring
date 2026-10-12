/*
 * GFI.i18n — 设置面板的中英文双语文案
 * 用法：
 *   GFI.i18n.set('zh' | 'en' | 0 | 1)             // 切换（也吃 enum 的索引）
 *   GFI.i18n.schema(entries)                      // 生成 Logseq 设置面板 schema
 *   GFI.i18n.t({ zh:'中文', en:'English' }, 'zh') // 取某一语言的一条文案
 *   GFI.i18n.relabelPanel()                       // 就地改写已渲染的面板文案
 * ── 语言值怎么持久化 ──
 * 走 `logseq.updateSettings({ language })`（见 config.js 的 onFreshSettings 写入
 * 与 syncSettings 的读取）。normalize() 同时接受字符串与 enum 的索引形态 ——
 * 实机反馈过"选了英文、下次还是中文"，索引形态就是最可能的原因。
 */
(function (GFI) {
  'use strict';
  if (GFI.i18n) return;

  const LANGS = ['zh', 'en'];
  const DEFAULT_LANG = 'zh';

  // 映射
  const ENUM_CHOICES = ['中文', 'English'];

  let lang = DEFAULT_LANG;

  function t(cb, force) {
    const L = force || lang;
    if (cb === undefined || cb === null) return '';
    if (typeof cb === 'string') return cb;          // 直接给字符串
    return cb[L] !== undefined ? cb[L] : (cb.zh !== undefined ? cb.zh : '');
  }

  function normalize(v) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      return LANGS[v] || DEFAULT_LANG;
    }
    const s = String(v === undefined || v === null ? '' : v).trim().toLowerCase();
    if (s === '') return DEFAULT_LANG;
    if (s === '1' || s === 'en' || s === 'english' || s === 'en-us') return 'en';
    if (s === '0' || s === 'zh' || s === 'cn' || s === 'zh-cn' || s === 'chinese' || s === '中文') return 'zh';
    // 兜底
    const idx = ENUM_CHOICES.findIndex((c) => String(c).trim().toLowerCase() === s);
    if (idx >= 0) return LANGS[idx] || DEFAULT_LANG;
    return DEFAULT_LANG;
  }

  function set(v) { lang = normalize(v); return lang; }
  function get() { return lang; }


  const SCHEMA = [
      {
        key: 'language',
        type: 'enum',
        enumChoices: ['中文', 'English'],
        enumPicker: 'radio',
        title: { zh: '界面语言 / Language', en: 'Language' },
        short: {
          zh: '面板语言',
          en: 'Panel language',
        },
        default: '中文',
      },
      {
        key: 'hideClassIdents',
        type: 'string',
        input: 'textarea',
        title: { zh: '自定义过滤类', en: 'Custom Excluded Classes' },
        short: {
          zh: '默认隐藏 Code、Page、Journal 等无查询意义的节点。\n' +
            '若想显示，请删除下方相关名称；\n' +
            '若想隐藏系统类，请查阅 Logseq 相关文档；\n' +
            '若想隐藏自定义类，请按照格式输入相关名称。',
          en: 'By default hides meaningless query nodes such as Code, Page, Journal.\n' +
            'To show them, delete the corresponding names below;\n' +
            'To hide system classes, see the Logseq documentation;\n' +
            'To hide custom classes, enter names in the format shown.',
        },
        default: '',
      },
      {
        key: 'hideNames',
        type: 'string',
        input: 'textarea',
        title: { zh: '自定义过滤名称', en: 'Custom Excluded Names' },
        short: {
          zh: '节点显示黑名单',
          en: 'Node display blacklist',
        },
        default: '',
      },
      {
        key: 'charge',
        type: 'number',
        title: { zh: '斥力强度', en: 'Repulsion' },
        short: {
          zh: '节点之间的排斥力，决定整体疏密',
          en: 'Repulsion between nodes; controls overall spread.',
        },
        default: -0.12,
      },
      {
        key: 'linkDistance',
        type: 'number',
        title: { zh: '连线长度', en: 'Link Distance' },
        short: {
          zh: '相连节点间的静止距离',
          en: 'Resting distance between connected nodes',
        },
        default: 50,
      },
      {
        key: 'timelapseRate',
        type: 'number',
        title: { zh: '时间旅行节奏', en: 'Timelapse Rate' },
        short: {
          zh: '越小节点出现越慢越缓，设置 0 按照自动化公式',
          en: 'Lower = slower reveal; 0 = auto formula',
        },
        default: 1,
      },
      {
        key: 'labelMaxRatio',
        type: 'number',
        title: { zh: '标签密度', en: 'Label Density' },
        short: {
          zh: '显示多少比例节点名称(1 = 全部)',
          en: 'Fraction of nodes eligible to show a name (1 = all)',
        },
        default: 1,
      },
      {
        key: 'labelJournal',
        type: 'boolean',
        title: { zh: '显示日记名字', en: 'Journal Labels' },
        short: {
          zh: '日记节点是否显示名字',
          en: 'Show names on journal nodes',
        },
        default: false,
      },
      {
        key: 'labelYield',
        type: 'boolean',
        title: { zh: '标签重叠时让位', en: 'Hide Overlapping Labels' },
        short: {
          zh: '关：允许重叠；开：重叠的互相让位',
          en: 'Off: allow overlap; On: overlaps yield',
        },
        default: false,
      },
      {
        key: 'nodeSize',
        type: 'number',
        title: { zh: '节点大小', en: 'Node Size' },
        short: {
          zh: '节点圆点的大小倍率',
          en: 'Scale of node dots',
        },
        default: 1,
      },
      {
        key: 'prewarm',
        type: 'boolean',
        title: { zh: '后台预热布局', en: 'Prewarm Layout in Background' },
        short: {
          zh: '插件加载后在后台把力导向跑到沉降，进图谱第一帧就是最终形态',
          en: 'Settle in the background; final on first paint',
        },
        default: true,
      },
      {
        key: 'syncSettleMs',
        type: 'number',
        title: { zh: '进图谱时同步抢跑上限 (ms)', en: 'Sync Settle Budget (ms)' },
        short: {
          zh: '加载指示后面把沉降一次跑完的时间上限',
          en: 'Time budget to finish settling behind the loading indicator',
        },
        default: 300,
      },
      {
        key: 'revealAnimMs',
        type: 'number',
        title: { zh: '图谱显现淡入', en: 'Reveal Fade-in' },
        short: {
          zh: '加载指示后节点显现时一次淡入时长，0 = 直接跳出',
          en: 'Fade-in duration when the graph appears; 0 = instant',
        },
        default: 320,
      },
      {
        key: 'velocityRetain',
        type: 'number',
        title: { zh: '速度保留率', en: 'Velocity Retain' },
        short: {
          zh: '每帧保留多少速度。越低收敛越快、手感越"重"',
          en: 'Velocity kept each frame. Lower = converges faster and feels heavier',
        },
        default: 0.6,
      },
      {
        key: 'settleTicks',
        type: 'number',
        title: { zh: '活跃时长', en: 'Settle Duration' },
        short: {
          zh: '开始布局到完全静止经过多少帧',
          en: 'Frames from layout start to full rest',
        },
        default: 400,
      },
      {
        key: 'linkBoost',
        type: 'number',
        title: { zh: '拖动带动邻域', en: 'Neighbour Pull' },
        short: {
          zh: '拖动节点时邻居跟随的程度',
          en: 'How strongly neighbours follow a dragged node',
        },
        default: 16,
      },
      {
        key: 'releaseAlpha',
        type: 'number',
        title: { zh: '松手停位', en: 'Drop Firmness' },
        short: {
          zh: '松手后节点活跃度。低则停在放下处；高会被拉回原位',
          en: 'Activity after release. Lower = stays where dropped; higher = pulled back',
        },
        default: 0.05,
      },
      {
        key: 'popAmp',
        type: 'number',
        title: { zh: '节点弹出幅度', en: 'Pop Overshoot' },
        short: {
          zh: '新节点出现时向外过冲幅度',
          en: 'Overshoot when a new node appears',
        },
        default: 0.55,
      },
      {
        key: 'popZeta',
        type: 'number',
        title: { zh: '弹出阻尼比', en: 'Pop Damping' },
        short: {
          zh: '回弹次数',
          en: 'Number of bounces',
        },
        default: 0.3,
      },
      {
        key: 'shockMagnitude',
        type: 'number',
        title: { zh: '时间波强度', en: 'Shockwave' },
        short: {
          zh: '向外扩散的斥力波强度，0：完全关闭',
          en: 'Outward repulsion wave strength; 0 = disabled',
        },
        default: 0,
      },
    ];

  /**
   * 把文案表编译成 Logseq 能用的 schema
   * @param {object[]} [entries] 
   */
    function schema(entries) {
      const src = entries || SCHEMA;
      return src.map((e) => {
        const out = {};
        for (const k in e) {
          if (k === 'title') out.title = t(e.title);
          else if (k === 'short') { /* 不直接进 schema */ }
          else out[k] = e[k];
        }
        out.description = t(e.short);
        return out;
      });
      }

  function audit(entries) {
    const src = entries || SCHEMA;
    const bad = [];
    for (const e of src) {
      for (const f of ['title', 'description', 'short']) {
        const cb = e[f];
        if (cb && typeof cb === 'object') {
          for (const L of LANGS) {
            if (!cb[L] || !String(cb[L]).trim()) bad.push(`${e.key}.${f}.${L} 缺失`);
          }
        }
      }
    }
    return bad;
  }

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  function inSettingsPanel(el) {
    let d = el, n = 0;
    while (d && n++ < 8) {
      const cls = String(d.className || '') + ' ' + String(d.id || '');
      if (/settings|plugin/i.test(cls)) return true;
      d = d.parentElement;
    }
    return false;
  }


  function hasInteractive(el) {
    try {
      const tag = String(el.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'button' || tag === 'select' ||
        tag === 'textarea' || tag === 'option') return true;
      if (el.querySelector &&
        el.querySelector('input, button, select, textarea, option')) return true;
    } catch (e) { /* 交给上层继续判断 */ }
    return false;
  }

  /**
   * 就地把面板上的文案换成当前语言。
   * @returns {number} 改写条数（0 = 没找到可改的节点，说明结构变了）
   */
  function relabelPanel(opts) {
    const doc = GFI.topDoc;
    if (!doc || !doc.querySelectorAll) return opts && opts.debug ? { hits: 0, scanned: 0, missed: [] } : 0;
    const debug = !!(opts && opts.debug);

    // 候选表：两个语言的 title / description / short → 目标语言文本
    const map = new Map();
    for (const e of SCHEMA) {
      for (const f of ['title', 'description', 'short']) {
        const cb = e[f];
        if (!cb || typeof cb !== 'object') continue;
        const target = t(cb);
        for (const L of LANGS) {
          const key = norm(cb[L]);
          if (key && !map.has(key)) map.set(key, target);
        }
      }
    }

    // 两道安全闸门
    let hits = 0;
    let scanned = 0;
    let skippedControls = 0;
    const missed = [];
    const all = doc.querySelectorAll('div, span, p, label, h1, h2, h3, h4, small, em, strong');
    for (const el of all) {
      let skip = false;
      for (let d = el; d; d = d.parentElement) if (d.__gfiSkip) { skip = true; break; }
      if (skip) continue;
      if (hasInteractive(el)) { skippedControls++; continue; }
      if (!inSettingsPanel(el)) continue;

      scanned++;
      const cur = norm(el.textContent);
      const target = map.get(cur);
      if (target === undefined) {
        if (debug && cur.length > 8) missed.push(cur.slice(0, 60));
        continue;
      }
      // 目标语言
      if (target === cur) continue;

      try {
        el.textContent = target;
        hits++;
      } catch (e) {
        // 即可极少数拒绝写入节点
      }
    }
    GFI.__relabelStat = { scanned, hits, skippedControls };
    return debug ? { hits, scanned, skippedControls, missed: missed.slice(0, 40) } : hits;
  }

  GFI.i18n = {
    t, set, get, normalize, schema, audit, SCHEMA, LANGS, DEFAULT_LANG, ENUM_CHOICES,
    relabelPanel, norm, inSettingsPanel, hasInteractive,
  };
})(window.GFI = window.GFI || {});
