/* 参数集成配置中心 */
(function (GFI) {
  'use strict';
  if (GFI.config) return;

  const defaults = {
    // 物理
    physics: {
      charge: -0.12,          // 整体疏密
      chargeFalloff: 0,       // 
      chargeDegGain: 0.5,     // 斥力随度数增长
      chargeDegCap: 8,        // 倍率上限
      distanceMin: 16,        // 软化近距奇点
      distanceMax: 420,       // 斥力截断半径
      linkDistance: 50,
      linkStrength: 0.5,      // 边刚度
      velocityRetain: 0.60,   // 每帧速度保留率
      settleTicks: 400,       // alpha 1→alphaMin 的 tick 数
      collideStrength: 1.0,   // 重叠消解强度
      collidePad: 10,
      skipIsolatedCharge: true,
      gravityDeadzone: 40,    // 死区半径
      gravity: 4,             // 向心恒力
      gravityDegGain: 0.5,
      centerStrength: 0.02,   // 刚性回正
      alphaMin: 0.001,
      collideCell: 48,       // 碰撞微网格边长（容纳放大后的 hub 节点）
      hubLinkThreshold: 5,   // hub边际
      hubLinkBoost: 3,       // hub-hub 边刚度倍率
      // 零度节点
      isolatedRing: {
        enabled: true,
        factor: 1.18,
        strength: 0.05,
      },
    },

    // 重热幅度
    reheat: {
      dataChange: 0.6,
      cutoff: 0.45,
      timelinePlay: 0.30,
      dragStart: 0.3,
      dragRelease: 0.3,
      fadeStart: 0.2,
      resize: 0.2,
      filter: 0.3,
    },

    // 节点显现
    pop: {
      simWeightRampFast: 0.3,
      simWeightRampSlow: 1.0,
      radialWaveSpeed: 1200,
      maxRadialDelay: 0.35,
      maxIndexDelay: 0.25,
    },

    // 拖拽
    drag: {
      linkBoost: 16,
      linkBoostDamp: 0.22,
      releaseAlpha: 0.05,
      minDragDist: 5.0,
      clickMaxMs: 600,
    },

    // 相机
    camera: {
      minZoom: 0.05,
      maxZoom: 6,
      zoomBase: 1.0012,
      fitPadding: 72,
      // 沉降后自动适配视野的缓动时长
      fitAnimMs: 320,
    },

    // 渲染
    render: {
      maxDpr: 2,
      bgFallback: '#0d0f14',
      bgCssVar: '--ls-primary-background-color',
      // 叶子节点直径 6~7px，核心 hub 直径 14~20px，
      radiusBase: 5.0,
      radiusScale: 1.8,
      radiusMin: 4.0,
      radiusMax: 22.0,
      nodeSize: 1.0,

      glowRadiusBuckets: [5, 7, 10, 14, 18, 24],
      glowSpread: 1.8,

      // 半透明纤细星轨（0.38 alpha）
      edgeColor: 'rgba(180,200,230,0.38)',
      // hover 时高亮爆发0.95 alpha，背景压暗0.12 alpha
      edgeColorDim: 'rgba(180,200,230,0.12)',
      edgeColorHi: 'rgba(160,200,255,0.95)',
      edgeWidthMin: 0.8,
      edgeWidthMax: 2.2,
      edgeWidthBase: 0.7,
      edgeWidthSlope: 0.4,

      labelShowScaleRatio: 0.35,
      labelHideScaleRatio: 0.28,
      labelFallbackShow: 0.20,
      labelFallbackHide: 0.16,
      // 标签重叠让位
      labelYield: false,
      labelOverlapDim: 0.35,
      // 0为不截断,设成正数则超过该字数后续 …
      labelMaxChars: 0,
      labelFont: '8px ui-sans-serif, -apple-system, "Segoe UI", sans-serif',
      labelColor: '#d9e2f0',
      labelColorDim: 'rgba(217,226,240,0.45)',
      labelColorHi: '#ffffff',
      labelHaloColor: 'rgba(8,10,14,0.7)',
      labelHaloWidth: 1.5,
      labelAlpha: 0.8,
      // 日记节点默认不显示名字标签
      labelJournal: false,
      labelMaxRatio: 1.0,
      // 占位格边长
      labelCell: 14,
      // 标签精灵缓存上限
      labelCacheMax: 1000,

      hoverScale: 1.35,
      selectionRingOffset: 2.5,

      palette: {
        tag: '#8b7bd8',
        page: '#7aa2f7',
        journal: '#5fa87a',
        object: '#8a8f98',
        property: '#c9a227',
      },
    },

    // LOD 档位
    lod: {
      auto: true,
      levels: [
        { maxN: 800, glow: 'all', glowMinScale: 0, labelCap: 800, collideIter: 2, skipIsolatedCharge: false, chargeEveryNth: 1, pulses: true },
        { maxN: 2200, glow: 'deg2', glowMinScale: 0, labelCap: 600, collideIter: 1, skipIsolatedCharge: false, chargeEveryNth: 1, pulses: true },
        { maxN: 5000, glow: 'deg2', glowMinScale: 0.5, labelCap: 400, collideIter: 1, skipIsolatedCharge: true, chargeEveryNth: 1, pulses: true },
        { maxN: Infinity, glow: 'hover', glowMinScale: 1, labelCap: 200, collideIter: 1, skipIsolatedCharge: true, chargeEveryNth: 2, pulses: false },
      ],
      sampleFrames: 30,
      downshiftMs: 15,
      upshiftMs: 8,
      upshiftHoldFrames: 120,
    },

    // 时间旅行
    timeline: {
      hideFadeTime: 0.26,
      hideShrink: 0.85,
      revealAnchorJitter: 30,
      revealFringeJitter: 80,
      revealRate: 0.5,
      burstSmoothing: true,
      speeds: [0.5, 1, 2, 4],
    },


    // 数据层
    data: {
      hideClassIdents: [
        'logseq.class/Journal',
        'logseq.class/Page',
        'logseq.class/Code-block',
        'logseq.class/Tag',
        'logseq.class/Whiteboard',
        'logseq.class/Comments',
        'logseq.class/Asset',
        'logseq.class/Root',
        'logseq.class/Template',
      ],
      hideNames: [
        'card', 'Property', 'Comment', 'Card', 'Cards', 'Alias', 'Bidirectional property title', 'Contents', 'Due',
        'Enable bidirectional properties', 'Extends', 'External URL',
        'Hide from Node', 'Library', 'Published URL',
        'Repeating recur frequency', 'Repeating recur unit', 'Repeating type',
        'State', 'Tag Properties', 'Title Format',
        'User Avatar', 'User Email', 'User Name',
        'include', 'Whiteboard', 'Template', 'PDF Annotation',
      ],
    },

    runtime: {
      maxSubsteps: 3,
      maxFrameMs: 100,  // 单帧最长有效时长
      idleFrames: 30,   // 每30帧做退化检测
      degenerateCheckEvery: 30,
      debug: false,
      dataSource: 'logseq',
      demoCount: 400,
    },

    // 布局预热
    warm: {
      enabled: true,
      budgetMs: 26,
      syncSettleMs: 300,
      maxTicksFactor: 2.5,
      revealAnimMs: 320,
    },

    // 右侧边栏的页面图谱
    sidebar: {
      enabled: true,
      fitPadding: 96,
      minNodes: 1,
      pageCheckMs: 1000,
    },
  };

  function clone(o) {
    if (Array.isArray(o)) return o.slice();
    if (o && typeof o === 'object') {
      const r = {};
      for (const k in o) r[k] = clone(o[k]);
      return r;
    }
    return o;
  }

  GFI.config = clone(defaults);
  GFI.configDefaults = defaults;

  // Logseq 设置面板 schema
  const SCHEMA_BINDINGS = {
    charge: () => GFI.configDefaults.physics.charge,
    linkDistance: () => GFI.configDefaults.physics.linkDistance,
    velocityRetain: () => GFI.configDefaults.physics.velocityRetain,
    settleTicks: () => GFI.configDefaults.physics.settleTicks,
    linkBoost: () => GFI.configDefaults.drag.linkBoost,
    releaseAlpha: () => GFI.configDefaults.drag.releaseAlpha,
    timelapseRate: () => GFI.configDefaults.timeline.revealRate >= 1 ? 'fast' : 'slow',
    labelMaxRatio: () => GFI.configDefaults.render.labelMaxRatio,
    labelJournal: () => GFI.configDefaults.render.labelJournal,
    labelYield: () => GFI.configDefaults.render.labelYield,
    nodeSize: () => GFI.configDefaults.render.nodeSize,
    hideClassIdents: () => GFI.configDefaults.data.hideClassIdents.join(', '),
    hideNames: () => GFI.configDefaults.data.hideNames.join(', '),
    prewarm: () => GFI.configDefaults.warm.enabled,
    syncSettleMs: () => GFI.configDefaults.warm.syncSettleMs,
    revealAnimMs: () => GFI.configDefaults.warm.revealAnimMs,
    language: () => '中文',
  };


  const i18n = GFI.i18n;
  if (!i18n) {
    console.error('[GFI] src/i18n.js 未加载 —— 检查 index.html 的脚本顺序');
  } else {
    for (const item of i18n.SCHEMA) {
      const bind = SCHEMA_BINDINGS[item.key];
      if (bind) item.default = bind();
    }
  }
  GFI.settingsSchema = i18n ? i18n.schema() : [];
  GFI.SCHEMA_BINDINGS = SCHEMA_BINDINGS;

  // 日记标签默认关闭
  GFI.CFG_VERSION = 17;

  const SANE_RANGE = {
    charge: (v) => v <= 0 && v >= -5,
    linkDistance: (v) => v >= 10 && v <= 500,
    velocityRetain: (v) => v > 0.3 && v < 1,
    settleTicks: (v) => v >= 50 && v <= 5000,
    linkBoost: (v) => v >= 1 && v <= 24,
    linkBoostDamp: (v) => v > 0.05 && v < 1,
    releaseAlpha: (v) => v >= 0.02 && v <= 1,
    labelMaxRatio: (v) => v > 0 && v <= 1,
    nodeSize: (v) => v >= 0.5 && v <= 2.5,
    syncSettleMs: (v) => v >= 0 && v <= 5000,
    revealAnimMs: (v) => v >= 0 && v <= 2000,
  };

  GFI.syncSettings = function syncSettings(s) {
    const c = GFI.config;
    const d = GFI.configDefaults;
    if (!s) s = {};

    const stale = [];
    const savedVersion = Number(s.__cfg || 0);
    const fresh = savedVersion !== GFI.CFG_VERSION;

    const pick = (key, cfgDefault) => {
      if (fresh) return cfgDefault;
      const raw = s[key];
      if (raw === undefined || raw === null || raw === '' || isNaN(Number(raw))) return cfgDefault;
      const v = Number(raw);
      const check = SANE_RANGE[key];
      if (check && !check(v)) {
        stale.push(`${key}=${v}（区间外）→ 用 ${cfgDefault}`);
        return cfgDefault;
      }
      return v;
    };

    c.useNativeGraph = !!s.useNativeGraph;

    // 语言 
    if (GFI.i18n) {
      const langCode = GFI.i18n.set(s.language);
      const idx = GFI.i18n.LANGS.indexOf(langCode);
      const canonical = GFI.i18n.ENUM_CHOICES[idx >= 0 ? idx : 0];
      if (s.language !== canonical) {
        s.language = canonical;
        try {
          if (typeof window !== 'undefined' && window.logseq && window.logseq.updateSettings) {
            window.logseq.updateSettings({ language: canonical });
          }
        } catch (e) { /* 写不进去也不影响本次生效 */ }
      }
      GFI.__langDiag = { 存档原始值: s.__langRaw, 归一化: langCode, 写回: canonical };
    }

    // 布局预热
    c.warm.enabled = fresh ? d.warm.enabled : (s.prewarm === undefined ? d.warm.enabled : !!s.prewarm);
    c.warm.syncSettleMs = pick('syncSettleMs', d.warm.syncSettleMs);
    c.warm.revealAnimMs = pick('revealAnimMs', d.warm.revealAnimMs);

    c.physics.charge = pick('charge', d.physics.charge);
    c.physics.linkDistance = pick('linkDistance', d.physics.linkDistance);
    c.physics.velocityRetain = pick('velocityRetain', d.physics.velocityRetain);
    c.physics.settleTicks = pick('settleTicks', d.physics.settleTicks);

    c.drag.linkBoost = pick('linkBoost', d.drag.linkBoost);
    c.drag.releaseAlpha = pick('releaseAlpha', d.drag.releaseAlpha);

    const RATE_MAP = { slow: 0.5, fast: 1.0 };
    const rateChoice = String(s.timelapseRate || '').trim().toLowerCase();
    c.timeline.revealRate = fresh
      ? d.timeline.revealRate
      : (RATE_MAP[rateChoice] !== undefined ? RATE_MAP[rateChoice] : d.timeline.revealRate);
    c.render.labelMaxRatio = pick('labelMaxRatio', d.render.labelMaxRatio);
    c.render.labelJournal = fresh ? d.render.labelJournal : !!s.labelJournal;
    c.render.labelYield = fresh ? d.render.labelYield : !!s.labelYield;
    c.render.nodeSize = pick('nodeSize', d.render.nodeSize);

    // 解析 hideNames
    let userNames = d.data.hideNames.slice();
    if (!fresh && s.hideNames !== undefined && s.hideNames !== null) {
      if (Array.isArray(s.hideNames)) {
        userNames = s.hideNames.map((x) => String(x).trim()).filter(Boolean);
      } else if (typeof s.hideNames === 'string') {
        userNames = s.hideNames
          .split(/[,\n]/)
          .map((x) => x.trim())
          .filter(Boolean);
      }
    }

    let classIdents = d.data.hideClassIdents.slice();

    // 解析 hideClassIdents
    if (!fresh && s.hideClassIdents !== undefined && s.hideClassIdents !== null) {
      let userClasses = [];
      if (Array.isArray(s.hideClassIdents)) {
        userClasses = s.hideClassIdents.map((x) => String(x).trim()).filter(Boolean);
      } else if (typeof s.hideClassIdents === 'string') {
        userClasses = s.hideClassIdents
          .split(/[,\n]/)
          .map((x) => x.trim())
          .filter(Boolean);
      }
      for (const ident of userClasses) {
        if (!classIdents.includes(ident)) classIdents.push(ident);
      }
    }
    c.data.hideClassIdents = classIdents;
    c.data.hideNames = userNames;

    if (fresh && GFI.onFreshSettings) {
      try {
        GFI.onFreshSettings({
          __cfg: GFI.CFG_VERSION,
          charge: c.physics.charge,
          linkDistance: c.physics.linkDistance,
          velocityRetain: c.physics.velocityRetain,
          settleTicks: c.physics.settleTicks,
          linkBoost: c.drag.linkBoost,
          releaseAlpha: c.drag.releaseAlpha,
          timelapseRate: c.timeline.revealRate >= 1 ? 'fast' : 'slow',
          labelMaxRatio: c.render.labelMaxRatio,
          labelJournal: c.render.labelJournal,
          labelYield: c.render.labelYield,
          nodeSize: c.render.nodeSize,
          hideClassIdents: c.data.hideClassIdents.join(', '),
          hideNames: c.data.hideNames.join(', '),
        });
      } catch (e) { }
    }
    return c;
  };
})(window.GFI = window.GFI || {});