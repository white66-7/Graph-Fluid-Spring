/*
 * GFI.i18n — 设置面板的中英文双语文案
 * 用法：
 *   GFI.i18n.set('zh' | 'en' | 0 | 1)             // 切换（也吃 enum 的索引）
 *   GFI.i18n.schema(entries)                      // 生成 Logseq 设置面板 schema
 *   GFI.i18n.t({ zh:'中文', en:'English' }, 'zh') // 取某一语言的一条文案
 *   GFI.i18n.relabelPanel()                       // 就地改写已渲染的面板文案
 *
 * ── 为什么单独一个模块 ──
 * config.js 已经 700 多行，而文案是纯数据、跟配置结构无关；更要紧的是要能被
 * 【单独测试】（test/headless-sim.js 直接断言两套文案键名一致、没有漏翻的条目）。
 *
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

  // ⚠ 这两个数组的【顺序必须一一对应】：索引 0 = 中文 = 'zh'，索引 1 = English = 'en'。
  //   normalize() 靠这个映射把 enum 的索引翻译成语言代码。
  const ENUM_CHOICES = ['中文', 'English'];

  let lang = DEFAULT_LANG;

  /** 取一条文案。cb 形如 { zh:'…', en:'…' }；缺翻译时回落到 zh，再回落到键名本身。 */
  function t(cb, force) {
    const L = force || lang;
    if (cb === undefined || cb === null) return '';
    if (typeof cb === 'string') return cb;          // 允许直接给字符串（不翻译）
    return cb[L] !== undefined ? cb[L] : (cb.zh !== undefined ? cb.zh : '');
  }

  // 语言值的归一化。
  //
  // ⚠ 必须同时吃下【字符串】和【索引】两种形态。
  //   我们的 enumChoices 是 ['中文', 'English']，Logseq 的 enum 控件理论上
  //   会把选中的那个字符串写回设置；但实机反馈「上次选了英文，这次进去还是中文」——
  //   最可能就是它写回的是**索引** 0/1（或者 '0'/'1'）。收到 1 时如果按字符串
  //   比较就会落进默认值 zh，表现正是"选了英文、下次还是中文"。
  //   所以这里显式处理：索引 → LANGS 顺序（LANGS = ['zh','en']，与 enumChoices 对齐）。
  function normalize(v) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      return LANGS[v] || DEFAULT_LANG;
    }
    const s = String(v === undefined || v === null ? '' : v).trim().toLowerCase();
    if (s === '') return DEFAULT_LANG;
    if (s === '1' || s === 'en' || s === 'english' || s === 'en-us') return 'en';
    if (s === '0' || s === 'zh' || s === 'cn' || s === 'zh-cn' || s === 'chinese' || s === '中文') return 'zh';
    // 兜底：直接按 enumChoices 的文案匹配（Logseq 可能把 label 原样写回）
    const idx = ENUM_CHOICES.findIndex((c) => String(c).trim().toLowerCase() === s);
    if (idx >= 0) return LANGS[idx] || DEFAULT_LANG;
    return DEFAULT_LANG;
  }

  function set(v) { lang = normalize(v); return lang; }
  function get() { return lang; }

  /**
   * schema 条目表。**key 与顺序就是设置面板的顺序**。
   * 每条的 title / description 都是 { zh, en }；其它字段（type/default/input）原样透传。
   *
   * ⚠ 顺序不是随便排的：
   *   1. `language` 必须第一条 —— 用户第一眼要做的选择
   *   2. 过滤/布局/显示这类【常用】项放前面
   *   3. 用户明确要求把 7 个"手感数值"（velocityRetain / settleTicks / linkBoost /
   *      releaseAlpha / popAmp / popZeta / shockMagnitude）放到【最后】
   *       —— 它们是调参项，平时不动
   *   4. `useNativeGraph` 已按用户要求从面板删除（config 里的字段与
   *      main.js 的原生模式回退逻辑仍保留，只是没有 UI 入口）
   */
  const SCHEMA = [
    {
      key: 'language',
      type: 'enum',
      enumChoices: ['中文', 'English'],
      enumPicker: 'radio',
      title: { zh: '🌐 界面语言 / Language', en: '🌐 界面语言 / Language' },
      description: {
        zh: '设置面板的语言。改完点【重新加载插件】生效；也可以在主窗口控制台运行 __GFI_LANG__("en") 就地切换。',
        en: 'Language of this settings panel. Reload the plugin after changing; or run __GFI_LANG__("en") in the main-window console to switch in place.',
      },
      short: {
        zh: '面板语言。改完点【重新加载插件】生效；也可以直接运行 __GFI_LANG__("en") 就地切换。',
        en: 'Panel language. Reload after changing; or run __GFI_LANG__("en") to switch in place.',
      },
      default: '中文',
    },
    {
      key: 'hideSystemJournal',
      type: 'boolean',
      title: { zh: '📅 删去 Journal 系统节点', en: '📅 Hide Journal System Node' },
      description: {
        zh: '是否从图谱中删去 Journal 系统节点（默认关：不删，保留展示）。',
        en: 'Delete/hide the Journal system node from the graph? (default false: keep)',
      },
      short: {
        zh: "从图谱中删去 Journal 系统节点（默认关：保留）。",
        en: "Remove the Journal system node from the graph (default: keep).",
      },
      default: false,
    },
    {
      key: 'hideSystemPages',
      type: 'boolean',
      title: { zh: '📄 删去 Page/Pages 系统节点', en: '📄 Hide Page/Pages System Node' },
      description: {
        zh: '是否从图谱中删去 Page / Pages 系统节点（默认关：不删，保留展示）。',
        en: 'Delete/hide the Page/Pages system node from the graph? (default false: keep)',
      },
      short: {
        zh: "从图谱中删去 Page / Pages 系统节点（默认关：保留）。",
        en: "Remove the Page/Pages system node from the graph (default: keep).",
      },
      default: false,
    },
    {
      key: 'hideNames',
      type: 'string',
      input: 'textarea',
      title: { zh: '🚫 自定义过滤名称', en: '🚫 Custom Excluded Names' },
      description: {
        zh: '填入需过滤的节点名称，用逗号或换行分隔。',
        en: 'Node names to exclude, separated by commas or newlines.',
      },
      short: {
        zh: "要过滤的节点名称，用逗号或换行分隔。",
        en: "Node names to exclude, separated by commas or newlines.",
      },
      default: '',
    },
    {
      key: 'charge',
      type: 'number',
      title: { zh: '⚡ 斥力强度', en: '⚡ Repulsion' },
      description: {
        zh: '节点之间的排斥力，决定整体疏密。（默认 -0.12）',
        en: 'Repulsion between nodes; controls overall spread. (default -0.12)',
      },
      short: {
        zh: "节点间的排斥力，决定整体疏密。绝对值越大越空灵。",
        en: "Repulsion between nodes; controls overall spread. Larger absolute value = airier.",
      },
      default: -0.12,
    },
    {
      key: 'linkDistance',
      type: 'number',
      title: { zh: '🔗 连接线长度', en: '🔗 Link Distance' },
      description: {
        zh: '相连节点之间的静止距离。（默认 50）',
        en: 'Resting distance between connected nodes. (default 50)',
      },
      short: {
        zh: "相连节点之间的静止距离。线长决定间距，与「节点大小」正交。",
        en: "Resting distance between connected nodes. This sets spacing; node size is orthogonal.",
      },
      default: 50,
    },
    {
      key: 'timelapseRate',
      type: 'number',
      title: { zh: '⏳ 演变节奏', en: '⏳ Timelapse Rate' },
      description: {
        zh: '每秒出现多少个节点。越小越慢；设 0 则按 Obsidian 的公式自动计算。\n全程时长 = 节点数 ÷ 这个值，所以节点多的时候会很久，嫌久就调大。',
        en: 'Nodes revealed per second. Lower = slower; 0 = auto (Obsidian\'s formula).\nTotal time = nodeCount ÷ rate, so large graphs take a while — raise this to speed up.',
      },
      short: {
        zh: "每秒出现多少个节点；0 = 自动。全程时长 = 节点数 ÷ 这个值。",
        en: "Nodes revealed per second; 0 = auto. Total time = nodeCount ÷ rate.",
      },
      default: 1,
    },
    {
      key: 'labelMaxRatio',
      type: 'number',
      title: { zh: '🏷 标签密度', en: '🏷 Label Density' },
      description: {
        zh: '多少比例的节点有资格显示名字（1 = 全部，密集处让缩放门槛决定取舍）。（默认 1）',
        en: 'Fraction of nodes eligible to show a name (1 = all; density is handled by the zoom threshold). (default 1)',
      },
      short: {
        zh: "多少比例的节点有资格显示名字（1 = 全部）。",
        en: "Fraction of nodes eligible to show a name (1 = all).",
      },
      default: 1,
    },
    {
      key: 'labelJournal',
      type: 'boolean',
      title: { zh: '📅 显示日记名字', en: '📅 Journal Labels' },
      description: {
        zh: '日记节点旁是否显示名字标签。默认关：只显示圆点，悬浮时仍能看到名字。',
        en: 'Show name labels on journal nodes? Default off: dots only — hover still reveals the name.',
      },
      short: {
        zh: "日记节点旁是否显示名字。默认只显示圆点，悬浮仍可见。",
        en: "Show names next to journal nodes. Off by default: dots only, hover reveals.",
      },
      default: false,
    },
    {
      key: 'labelYield',
      type: 'boolean',
      title: { zh: '🈳 标签重叠时让位', en: '🈳 Hide Overlapping Labels' },
      description: {
        zh: '关闭（默认，与 Obsidian 一致）= 每个节点都显示名字、允许重叠，密集处靠"放大才显示"控制。\n开启 = 重叠的标签互相让位，画面更干净，但会有很多节点永远看不到名字。',
        en: 'Off (default, matches Obsidian) = every node shows its name, overlap allowed; density is controlled by the zoom threshold.\nOn = overlapping labels yield to each other: cleaner, but many nodes never show a name.',
      },
      short: {
        zh: "关（默认，同 Obsidian）= 名字都显示、允许重叠；开 = 重叠的互相让位。",
        en: "Off (default, like Obsidian) = all names shown, may overlap; on = overlaps yield.",
      },
      default: false,
    },
    {
      key: 'nodeSize',
      type: 'number',
      title: { zh: '🔵 节点大小', en: '🔵 Node Size' },
      description: {
        zh: '节点圆点的大小倍率。它【完全不改动布局】—— 线长决定间距，这里只决定直径。范围 0.5~2.5，超过 2.5 会被碰撞顶开反而变松。（默认 1.0）',
        en: 'Scale of node dots. Does not change the layout at all — link distance controls spacing, this only controls diameter. Range 0.5~2.5; above 2.5 collisions push nodes apart and it gets looser. (default 1.0)',
      },
      short: {
        zh: "节点圆点的大小倍率。完全不改动布局，只改直径。范围 0.5~2.5。",
        en: "Scale of node dots. Does not change layout, only diameter. Range 0.5~2.5.",
      },
      default: 1,
    },
    {
      key: 'prewarm',
      type: 'boolean',
      title: { zh: '🚀 后台预热布局', en: '🚀 Prewarm Layout in Background' },
      description: {
        zh: '开着：插件加载后在后台把力导向跑到沉降，进图谱时第一帧就是最终形态、不需要再适配一次视野。\n关掉：省下那点 CPU，代价是进图谱时能看见图谱当场"摊开"。',
        en: 'On: after the plugin loads, the force simulation is settled in the background, so the graph is already in its final form on first paint (no second camera fit).\nOff: saves some CPU, but you will see the graph spread out live when you open it.',
      },
      short: {
        zh: "插件加载后在后台把力导向跑到沉降，进图谱第一帧就是最终形态。",
        en: "Settle the force simulation in the background so the graph is final on first paint.",
      },
      default: true,
    },
    {
      key: 'syncSettleMs',
      type: 'number',
      title: { zh: '⏱ 进图谱时同步抢跑上限 (ms)', en: '⏱ Sync Settle Budget (ms)' },
      description: {
        zh: '后台预热没跑完时，在加载指示后面把剩下的沉降一次跑完的时间上限。\n实测整段沉降：200 节点 ≈0.5s、500 节点 ≈2.0s、1000 节点 ≈7.2s。\n所以只有中小库能在预算内一步到位；超预算会立刻回退（大库仍会看到图谱摊开）。',
        en: 'When the background prewarm has not finished, how long we may block (behind the loading indicator) to finish settling.\nMeasured total settle: 200 nodes ≈0.5s, 500 nodes ≈2.0s, 1000 nodes ≈7.2s.\nOnly small/medium graphs fit in budget; over budget we fall back immediately (large graphs still spread out live).',
      },
      short: {
        zh: "预热没跑完时，在加载指示后面把沉降一次跑完的时间上限。",
        en: "Time budget to finish settling behind the loading indicator when prewarm is unfinished.",
      },
      default: 300,
    },
    {
      key: 'revealAnimMs',
      type: 'number',
      title: { zh: '✨ 图谱显现淡入 (ms)', en: '✨ Reveal Fade-in (ms)' },
      description: {
        zh: '图谱从加载指示后面显现时的一次淡入时长，0 = 直接跳出来。\n只作用于"刚现场跑完沉降"的那次首开；之后走缓存的重开是静止的。',
        en: 'Duration of the one fade-in when the graph appears from behind the loading indicator; 0 = instant.\nOnly applies to the first open that just settled live; later opens from cache are static.',
      },
      short: {
        zh: "图谱从加载指示后面显现时的一次淡入时长，0 = 直接跳出。",
        en: "Fade-in duration when the graph appears from behind the loading indicator; 0 = instant.",
      },
      default: 320,
    },
    {
      key: 'velocityRetain',
      type: 'number',
      title: { zh: '🌀 速度保留率', en: '🌀 Velocity Retain' },
      description: {
        zh: '每帧保留多少速度。越低收敛越快、越"重"。（默认 0.60）',
        en: 'How much velocity is kept each frame. Lower = converges faster, feels heavier. (default 0.60)',
      },
      short: {
        zh: "每帧保留多少速度。越低收敛越快、手感越\"重\"。",
        en: "Velocity kept each frame. Lower = converges faster and feels heavier.",
      },
      default: 0.6,
    },
    {
      key: 'settleTicks',
      type: 'number',
      title: { zh: '⏱ 活跃时长', en: '⏱ Settle Duration' },
      description: {
        zh: '图谱从开始布局到完全静止经过多少帧。这个值也决定【预热】要跑多久。（默认 400）',
        en: 'Frames from start of layout to full rest. Also decides how long the background prewarm runs. (default 400)',
      },
      short: {
        zh: "从开始布局到完全静止经过多少帧。也决定后台预热要跑多久。",
        en: "Frames from layout start to full rest. Also sets how long the background prewarm runs.",
      },
      default: 400,
    },
    {
      key: 'linkBoost',
      type: 'number',
      title: { zh: '🧲 拖动带动邻域', en: '🧲 Neighbour Pull' },
      description: {
        zh: '拖动节点时邻居跟随的力度，只作用于被拖节点自己的连线。实测 16 最优；超过 24 有让布局发散的风险。（默认 16）',
        en: 'How strongly neighbours follow a dragged node; only affects that node\'s own links. Measured optimum 16; above 24 the layout may diverge. (default 16)',
      },
      short: {
        zh: "拖动节点时邻居跟随的力度，只影响被拖节点自己的连线。",
        en: "How strongly neighbours follow a dragged node; only that node's own links.",
      },
      default: 16,
    },
    {
      key: 'releaseAlpha',
      type: 'number',
      title: { zh: '🪂 松手停位', en: '🪂 Drop Firmness' },
      description: {
        zh: '松手后布局的活跃度。越低，节点越能停在你放下的地方；越高越会被连线拉回原位。实测 0.05 最优，低于 0.02 图会僵住。（默认 0.05）',
        en: 'Layout activity after release. Lower = nodes stay where you dropped them; higher = links pull them back. Measured optimum 0.05; below 0.02 the graph stiffens. (default 0.05)',
      },
      short: {
        zh: "松手后的活跃度。越低越能停在放下处；越高越会被拉回原位。",
        en: "Activity after release. Lower = stays where dropped; higher = pulled back.",
      },
      default: 0.05,
    },
    {
      key: 'popAmp',
      type: 'number',
      title: { zh: '💥 节点弹出幅度', en: '💥 Pop Overshoot' },
      description: {
        zh: '新节点出现时向外过冲的幅度。（默认 0.55）',
        en: 'Overshoot when a new node appears. (default 0.55)',
      },
      short: {
        zh: "新节点出现时向外过冲的幅度。",
        en: "Overshoot when a new node appears.",
      },
      default: 0.55,
    },
    {
      key: 'popZeta',
      type: 'number',
      title: { zh: '💥 弹出阻尼比', en: '💥 Pop Damping' },
      description: {
        zh: '越低回弹次数越多。（默认 0.30）',
        en: 'Lower = more bounces. (default 0.30)',
      },
      short: {
        zh: "弹出阻尼比，越低回弹次数越多。",
        en: "Pop damping ratio; lower = more bounces.",
      },
      default: 0.3,
    },
    {
      key: 'shockMagnitude',
      type: 'number',
      title: { zh: '🌊 时间波强度', en: '🌊 Shockwave' },
      description: {
        zh: '时间轴推进时，向外扩散的斥力波前强度。设为 0 完全关闭。（默认 0）',
        en: 'Strength of the outward repulsion wavefront as the timeline advances. 0 disables it. (default 0)',
      },
      short: {
        zh: "时间轴推进时向外扩散的斥力波强度，0 完全关闭。",
        en: "Outward repulsion wave as the timeline advances; 0 disables it.",
      },
      default: 0,
    },
  ];

  /**
   * 把文案表编译成 Logseq 能用的 schema（当前语言）。
   * @param {object[]} [entries] 不传则用内置表
   */
  function schema(entries) {
    const src = entries || SCHEMA;
    return src.map((e) => {
      const out = {};
      for (const k in e) {
        if (k === 'title') out.title = t(e.title);
        // ⚠ 面板上用 short（1~2 行），实测依据那种长文案留给 DEVELOPMENT.md ——
        //   描述越长面板越高，实测已到 scrollHeight 10572px 对 286px 视口。
        else if (k === 'description') out.description = t(e.short || e.description);
        else if (k === 'short') { /* 不直接进 schema */ }
        else out[k] = e[k];
      }
      return out;
    });
  }

  /** 自检：两套语言的键名是否一致（漏翻检测）。返回不一致的条目列表。 */
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

  // ---------------------------------------------------------------------------
  // 就地改写设置面板文案（不用重载插件）
  // ---------------------------------------------------------------------------
  // 为什么需要：Logseq 的 `useSettingsSchema` 只在插件启动时被读一次，面板渲染
  // 完就没有回调了。原先的结论是"改语言必须重载插件"，但用户实测「切了不生效」
  // —— 靠重载既慢又容易让人以为坏了。面板就是普通 DOM，我们可以直接把文字换掉。
  //
  // ⚠ 匹配策略刻意【不依赖 Logseq 的类名】：那是内部实现，版本一变就废。
  //   改成"按文字内容反查"—— 把我们两个语言的 title/description 归一化成候选表，
  //   谁的文字命中，就把它换成当前语言的版本。
  //   · 归一化只把连续空白压成一个空格（描述里的 \n 渲染出来就是空白）
  //   · 只改【叶子】元素（内部没有元素子节点），避免把一个容器的整段内容冲掉
  //   · 只在疑似设置面板的子树里动手，绝不碰图谱或正文
  //   返回真正改写的条数 —— 0 就意味着面板结构变了，得重新看 DOM。

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  /** 该元素是否在疑似"设置面板"的子树里（往上找带 settings/plugin 的 class/id） */
  function inSettingsPanel(el) {
    let d = el, n = 0;
    while (d && n++ < 8) {
      const cls = String(d.className || '') + ' ' + String(d.id || '');
      if (/settings|plugin/i.test(cls)) return true;
      d = d.parentElement;
    }
    return false;
  }

  /**
   * 这个元素里有没有"交互控件"（输入框 / 单选 / 按钮 / 下拉 / 文本域 / option）。
   *
   * ⚠⚠ 这是修「点了中英文之后可选框没了」的那道保险。
   *   事故经过：`relabelPanel` 靠"整体文本匹配"改写，而某个**容器**的整段文本
   *   恰好等于我们的某条文案时，`el.textContent = target` 会把容器里的
   *   `<input type=radio>` + `<label>` 一起换成一个纯文本节点 —— **UI 直接被抹掉**。
   *   所以：只要元素内部（含自身）有控件，一律不碰。
   *   Logseq 的 enum 用 radio 渲染，正好命中这条。
   */
  function hasInteractive(el) {
    try {
      const tag = String(el.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'button' || tag === 'select' ||
          tag === 'textarea' || tag === 'option') return true;
      if (el.querySelector &&
          el.querySelector('input, button, select, textarea, option')) return true;
    } catch (e) { /* 假 DOM / 只读节点：当作没有控件，交给上层继续判断 */ }
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

    // ⚠ 两道安全闸门，都不能省：
    //   ① 跳过我们自己注入的容器（__gfiSkip）
    //   ② 跳过任何含交互控件的元素 —— 否则会把 enum 的单选框抹掉（踩过）
    //   除此之外【不跳过含行内元素的节点】：Logseq 会把描述里的 **粗体** /
    //   `代码` 渲染成 <strong>/<code>，跳过它们就会漏改（用户报过
    //   「某些简介不切换」）。整体文本能命中就整体替换 —— 目标是纯文本，
    //   富文本片段一并去掉，这是刻意的取舍。
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
        // 收集"看起来像我们的文案但没匹配上"的候选，便于 debug
        if (debug && cur.length > 8) missed.push(cur.slice(0, 60));
        continue;
      }
      if (target === cur) continue;               // 已经是目标语言

      // ⚠ 目标文案是【纯文本】，所以直接整体替换元素内容：
      //   把 textContent 写成目标值 —— 浏览器会把所有子节点（文本 + <strong>/<code>）
      //   一并换成单个文本节点。
      //
      //   为什么不能只写"第一个文本节点"：
      //     · 元素内部只有 <strong>/<code>（没有裸文本）时，根本没有文本节点可写 ——
      //       那时若新建一个文本节点插进去，**旧的元素子节点还在**，新旧文案会叠在
      //       一起（实测得到 "Pop damping ratio….弹出阻尼比…" 这种拼接结果）。
      //     · 描述里的粗体/代码片段本来就是装饰，留不保留都不影响可读性，
      //       而"能切换语言"明显更重要。
      //   用 innerHTML = '' + 文本节点的话在真实 DOM 里安全（内容来自我们自己的
      //   文案表，不含 HTML），但 textContent 更直白、也不依赖任何解析。
      try {
        el.textContent = target;
        hits++;
      } catch (e) {
        // 极少数只读节点会拒绝写入，跳过即可，别让整轮改写中断
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
