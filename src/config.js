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
      linkStrength: 0.3,      // 边刚度
      velocityRetain: 0.60,   // 每帧速度保留率
      settleTicks: 400,       // alpha 1→alphaMin 的 tick 数
      collideStrength: 1.0,   // 重叠消解强度（1 = d3 forceCollide 约定：每遍完全解消）
      // 🌟 d3 forceCollide 的 padding：每节点外扩该值，静止间距 = r_i+r_j+2·pad。
      //   这是「节点之间永远有可见空隙」的来源 —— 没有 padding 时斥力/弹簧/重力
      //   的压力会把节点一路压到【接触距离】才停（实测最近邻 p10 = 13.6 ≈
      //   两片叶子半径之和 6.8+6.8），表现就是整团挤成一坨。
      //   探针实测：pad 6 → CV 0.549、间距 25.6/26.3/41.6（p10/p50/p90）。
      collidePad: 10,
      skipIsolatedCharge: true,
      // 🌟 2（原 3）：向心压缩减 1/3。gravity 是唯一把图谱往一起收的力，
      //   减弱它 = 团簇之间松开 = 分布更均匀。
      gravityDeadzone: 40,    // 死区半径
      gravity: 2,             // 向心恒力
      centerStrength: 0.02,   // 刚性回正
      alphaMin: 0.001,
      collideCell: 48,        // 碰撞微网格边长（容纳放大后的 hub 节点）

      // 零度节点（无连边）锚定外圈环
      isolatedRing: {
        enabled: true,
        factor: 1.18,
        strength: 0.05,
      },
    },

    // 重热幅度(alpha)
    reheat: {
      dataChange: 0.6,
      cutoff: 0.45,
      //   实测来源：app.js 的 setData()，数据一变（= 有时间旅行揭示/新增节点）就
      //     `this.worker.postMessage({nodes:a, links:Y, alpha:.3, run:true})`
      //   这是 Obsidian 在【力的层面】对「节点出现」做的唯一一件事 —— 没有速度
      //   注入、没有后坐力。所以「节点出现把其他节点推开」这个效果，在 Obsidian
      //   里完全来自：新节点落在邻居质心 + 力场被抬到 alpha 0.3。
      //
      //   实测本插件（81 节点库 / 演变节奏 1/s），每 30 帧一窗量全场最大位移：
      //     alpha 0.12 → 有出生窗口 396wu，无出生窗口 17.8wu
      //     alpha 0.30 → 有出生窗口 434wu，无出生窗口 21.3wu   ← 净效应 +9%
      //   ⚠ 无出生窗口只有 20wu 左右，说明两次出生之间图谱依然是安静的 ——
      //     之前「整张图停不下来」是 alpha 0.32 + 28 秒（2.9 个/秒）叠出来的，
      //     现在节奏降到 1 个/秒、弹簧缩放与喷射也关了，把值还回 Obsidian 原数
      //     不会把那时的观感带回来。
      timelinePlay: 0.30,
      dragStart: 0.3,
      // 🌟 0.3（原 0.4）：松手不额外加压 —— d3 拖拽惯例是全程 alphaTarget 0.3、
      //   松手让它自然衰减。松手瞬间比拖拽时更热只会放大「弹簧把节点拽回去」。
      dragRelease: 0.3,
      pulse: 0.5,
      fadeStart: 0.2,
      resize: 0.2,
      filter: 0.3,
    },

    // pop-out 弹簧 / 节点出生缓动
    pop: {
      // 🌟 'obsidian' | 'spring'。实测 Obsidian app.asar 后新增。
      //
      //   'obsidian' —— 纯淡入：alpha ← alpha×0.9 + 1×0.1（每帧），无缩放、
      //     无过冲、无弹跳。若同时把 timeline 的出生喷射速度也关掉（本插件
      //     已按此模式自动关），就是 Obsidian 时间旅行的原样。
      //   'spring'   —— 本插件原版：欠阻尼弹簧缩放（下面 amp/omega/zeta），
      //     配 timeline 里的喷射初速 22 + 母节点后坐力。更"活"，但也更"急"。
      //
      //   实测对照（81 节点库）：
      //     spring   ：每个节点缩放 1→1.55→0.95→1，带 22wu/s 喷射 + 母体反冲
      //     obsidian ：纯 alpha 0→1，470ms 到 95% —— 安静得多
      mode: 'obsidian',
      amp: 0.55,
      omega: 12,
      zeta: 0.30,
      maxDuration: 1.0,
      fadeInTime: 0.08,
      // 🌟 出生时【受力权重】的渐入时长（秒）。0 = 首帧全开（改动前的行为）。
      //
      //   为什么需要：新节点落在「已存在邻居的质心」，距离邻居趋近 0。而斥力用的是
      //   `chargeFalloff: 0`（恒定幅值，不随距离衰减），于是它一出生就对邻居施加
      //   【满幅】的推力。实测（把邻居逐帧 Δv 分解，81 节点库）：
      //     全部力     前 3 帧占 49% 冲量，首帧 Δv = 1.14
      //     关掉斥力   首帧 Δv 0.39（−66%）—— 主犯是斥力
      //     关掉弹簧   首帧 Δv 0.05（−96%）—— 次犯
      //     关掉碰撞   几乎不变        —— 碰撞与它无关
      //   即「出生那一下很突然」= 一半的冲量挤在 50ms 里。让 simWeight 渐入就把这 50ms 摊开。
      //
      //   扫过 0 / 0.3 / 0.5 / 0.9（200 节点 × 6 种子，播完再沉降后量布局）：
      //     ramp 0   首帧 Δv 1.14、前3帧占 49% 冲量、间距 CV 0.817
      //     ramp 0.3 首帧 Δv 0.11、前3帧占 16%     、间距 CV 0.865   ← 现值
      //     ramp 0.5 首帧 Δv 0.10、前3帧占 19%     、间距 CV 0.890
      //   0.3 与 0.5 消除闷棍的效果一样（−90%），但 0.3 的布局代价更小、
      //
      //   ⚠ 曾经这里是 0.01（几乎等于立即全开），且当年还刻意写成「首帧全受力」
      //     来杜绝"隐形中弹完"。那条理由是针对【弹簧缩放弹出】那条动画的：弹出
      //     0.5 秒就结束，力要是不跟上，等你看清节点时它已经站好了。现在观感问题
      //     反过来 —— 首帧一记闷棍才是"突然"的来源，所以改成渐入。
      simWeightRamp: 0.3,
      radialWaveSpeed: 1200,
      maxRadialDelay: 0.35,
      maxIndexDelay: 0.25,
    },

    // 激波 —— 行进波前
    shock: {
      speed: 2400,
      decayLen: 1800,
      // 🌟 关闭全屏扩散激波，彻底消除“远近节点被先后击中”的时差拖沓感
      magnitude: 0,
      jitter: 0.30,
      massFactor: 0.06,
      maxRadiusFactor: 1.25,
      maxRadius: 2600,
      maxDisplacementRatio: 0.22,
      backwardSign: -1,
    },

    // 拖拽
    drag: {
      // 🌟 拖动期间给【被拖节点关联的边】临时加刚度 —— 邻居跟着走，图不被扯裂。
      //
      //   lstr[e] = clamp(linkStrength / minDeg, 0.02, 0.5)，边刚度按两端较【低】
      //   度数衰减；被拖的恰恰就是这个低度数叶子，它连到 hub 的边只有 0.3/3 = 0.1，
      //   再乘 alpha 0.3 → 邻居每 tick 只拿到约 0.7wu 加速度。
      //   实测（test/drag-probe.js，拖 234wu）：邻居只跟出 91wu，关联边被拉伸到
      //   379%，松手瞬间被拖节点离最近邻居 142wu（基线 26.4、平衡边长 50）。
      //   加 ×16 → 撕裂 379%→187%，小拖甩飞峰值 112→27wu。
      //   ⚠ 上限 24：实测 2~3 跳增益更差（局部硬斑对抗全局布局，全局撕裂
      //     63%→110%），hop3×40 会让坐标发散到无穷、网格分配直接 OOM。
      linkBoost: 16,
      // 🌟 被拖节点【直接邻居】的额外速度阻尼（velocityRetain 的覆盖值）。
      //
      //   刚度倍率只放大弹簧力、不放大阻尼，所以必须配套补阻尼，否则进深欠阻尼区：
      //   离散步进 trace = 1 + D(1−k)、det = D，k = a·lstr·be·biasT。
      //   拖 hub 时邻居是叶子（lstr = clamp(0.3/1,…) = 0.3）且 biasT = 56/57 ≈ 0.98，
      //   k = 0.3×0.3×16×0.98 ≈ 1.41 → 振荡周期 ≈ 5.3 帧（11Hz）、每周期只衰减 15%
      //   —— 肉眼就是「大节点周围在抽搐」。实测（test/drag-jitter-probe.js）：
      //   be=16 时邻居位移折返率 21.9%，be=1 时 0.1%。
      //   临界阻尼条件 (1 + D(1−k))² = 4D → k=1.41 时 D ≈ 0.21。
      //   ⚠ 只在拖拽期间、只作用于被拖节点的一环，不影响图的其他部分。
      linkBoostDamp: 0.22,
      // 🌟 松手时把 alpha 压到这个水平（而不是停在拖拽期的 0.3）。
      //   这是「停在放下点」的关键：回弹幅度几乎正比于松手后的 alpha。
      //   实测大拖回弹 156（alpha .30）→ 94（.08）→ 83（.05）；小拖峰值 112 → 29。
      //   ⚠ 不能压到 0.02：图会僵住，残余变形收不回来（末尾邻距 27 → 43）。
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
      labelFont: '12px ui-sans-serif, -apple-system, "Segoe UI", sans-serif',
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
      pulseThrottleMs: 900,
      pulseMinReveal: 2,
      maxPulses: 2,
      poolSize: 4,
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
    popAmp: () => GFI.configDefaults.pop.amp,
    popZeta: () => GFI.configDefaults.pop.zeta,
    linkBoost: () => GFI.configDefaults.drag.linkBoost,
    releaseAlpha: () => GFI.configDefaults.drag.releaseAlpha,
    shockMagnitude: () => GFI.configDefaults.shock.magnitude,
    timelapseRate: () => GFI.configDefaults.timeline.revealRate,
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
  GFI.CFG_VERSION = 16;

  const SANE_RANGE = {
    charge: (v) => v <= 0 && v >= -5,
    linkDistance: (v) => v >= 10 && v <= 500,
    velocityRetain: (v) => v > 0.3 && v < 1,
    settleTicks: (v) => v >= 50 && v <= 5000,
    popAmp: (v) => v >= 0 && v <= 2,
    popZeta: (v) => v > 0.05 && v < 1,
    linkBoost: (v) => v >= 1 && v <= 24,
    linkBoostDamp: (v) => v > 0.05 && v < 1,
    releaseAlpha: (v) => v >= 0.02 && v <= 1,
    shockMagnitude: (v) => v >= 0 && v <= 2000,
    timelapseRate: (v) => v >= 0 && v <= 200,
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

    c.pop.amp = pick('popAmp', d.pop.amp);
    c.pop.zeta = pick('popZeta', d.pop.zeta);

    c.drag.linkBoost = pick('linkBoost', d.drag.linkBoost);
    c.drag.releaseAlpha = pick('releaseAlpha', d.drag.releaseAlpha);

    c.shock.magnitude = pick('shockMagnitude', d.shock.magnitude);
    c.timeline.revealRate = pick('timelapseRate', d.timeline.revealRate);
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
          popAmp: c.pop.amp,
          popZeta: c.pop.zeta,
          linkBoost: c.drag.linkBoost,
          releaseAlpha: c.drag.releaseAlpha,
          shockMagnitude: c.shock.magnitude,
          timelapseRate: c.timeline.revealRate,
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