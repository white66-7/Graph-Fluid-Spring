/*
 * Probe v3: reach Logseq's d3-force simulation?
 *
 * Paste into the DevTools console of the MAIN Logseq window (Ctrl+Shift+I)
 * with the graph view open. Send the output back.
 *
 * v2 scanned 890 React fibers and 91 globals and found nothing, but it only
 * descended through `current` / `memoizedState` / `next` / arrays. It never
 * walked ordinary object properties — and Logseq exposes internals under
 * window.frontend (seen in app.asar: window.frontend.modules.layout.core...),
 * which v2 would have walked straight past.
 *
 * v3 does a real bounded recursive descent over arbitrary properties, starting
 * from window.frontend and friends, and dumps their shape so we learn what is
 * actually exposed even on failure.
 */
(() => {
  const MAX_VISITED = 200000;
  const MAX_DEPTH = 7;
  const MAX_ARRAY = 24;

  function looksLikeSimulation(o) {
    if (!o || typeof o !== 'object') return false;
    if (typeof o.alpha !== 'function') return false;
    return (
      typeof o.tick === 'function' ||
      typeof o.force === 'function' ||
      typeof o.nodes === 'function'
    );
  }

  function describe(sim, path) {
    const call = (n) => {
      try {
        return typeof sim[n] === 'function' ? sim[n]() : undefined;
      } catch (e) {
        return `<threw: ${e.message}>`;
      }
    };
    const nodes = call('nodes');
    const forces = call('force');
    return {
      path,
      nodeCount: Array.isArray(nodes) ? nodes.length : null,
      alpha: call('alpha'),
      alphaTarget: call('alphaTarget'),
      alphaMin: call('alphaMin'),
      forces: forces && typeof forces.keys === 'function' ? Array.from(forces.keys()) : null,
      sampleNode: Array.isArray(nodes) && nodes[0] ? Object.keys(nodes[0]).slice(0, 14) : null,
    };
  }

  const visited = new Set();
  const found = [];
  let count = 0;

  function isDomNode(o) {
    return typeof Node !== 'undefined' && o instanceof Node;
  }

  function descend(obj, path, depth) {
    if (found.length || count > MAX_VISITED) return;
    if (!obj || typeof obj !== 'object') return;
    if (isDomNode(obj)) return;
    if (visited.has(obj)) return;
    visited.add(obj);
    count++;

    if (looksLikeSimulation(obj)) {
      found.push(describe(obj, path));
      return;
    }
    if (depth >= MAX_DEPTH) return;

    let keys;
    try {
      keys = Object.keys(obj);
    } catch (e) {
      return;
    }
    for (const key of keys) {
      if (/^(__react|_react|webkit)/.test(key)) continue;
      let val;
      try {
        val = obj[key]; // may throw via getter
      } catch (e) {
        continue;
      }
      const t = typeof val;
      if (t !== 'object' || val === null) continue;
      if (isDomNode(val)) continue;
      if (Array.isArray(val)) {
        for (let i = 0; i < Math.min(val.length, MAX_ARRAY); i++) {
          descend(val[i], `${path}.${key}[${i}]`, depth + 1);
        }
      } else {
        descend(val, `${path}.${key}`, depth + 1);
      }
      if (found.length) return;
    }
  }

  // Roots most likely to expose internals.
  const roots = [
    ['window.frontend', () => window.frontend],
    ['window.logseq', () => window.logseq],
    ['window.LSPluginCore', () => window.LSPluginCore],
    ['window.lsplugin', () => window.lsplugin],
    ['window.__LSP__HOST__', () => window.__LSP__HOST__],
  ];

  for (const [name, get] of roots) {
    let val;
    try {
      val = get();
    } catch (e) {
      console.log(`[probe] ${name}: threw`);
      continue;
    }
    if (!val || typeof val !== 'object') {
      console.log(`[probe] ${name}: ${val === undefined ? 'undefined' : typeof val}`);
      continue;
    }
    console.log(`[probe] ${name} keys:`, Object.keys(val).slice(0, 40));
    descend(val, name, 0);
    if (found.length) break;
  }

  // Then every remaining window global.
  if (!found.length) {
    let scanned = 0;
    for (const key of Object.getOwnPropertyNames(window)) {
      if (/^(webkit|chrome|on|__react)/i.test(key)) continue;
      if (roots.some(([n]) => n === `window.${key}`)) continue;
      let val;
      try {
        val = window[key];
      } catch (e) {
        continue;
      }
      if (!val || typeof val !== 'object') continue;
      scanned++;
      descend(val, `window.${key}`, 0);
      if (found.length) break;
    }
    console.log(`[probe] globals descended into: ${scanned}`);
  }

  console.log(`[probe] objects visited: ${count}`);
  if (found.length) {
    console.log('%c[probe] SIMULATION FOUND', 'color:#0a0;font-weight:bold', found);
  } else {
    console.warn('[probe] still nothing. Send this output back.');
  }
})();
