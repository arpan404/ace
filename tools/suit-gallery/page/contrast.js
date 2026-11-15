// Text contrast over the live scene, the way the mock draws it. The scene is read through the
// runtime's own `sample` message (a 32 × 32 grid of the canvas), then for each text element the
// backdrop under it is composited as the browser draws it: the scene blurred by the glass's
// blur radius and saturated, the glass tint over it, any fills between (selected row, message
// bubble, code), then the text colour with its alpha. The worst WCAG ratio over the cells under
// the text is reported. A text part with no glass behind it (the header) sits on the scene.
const channel = (value) => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const over = (top, alpha, bottom) => bottom.map((value, i) => top[i] * alpha + value * (1 - alpha));
const parse = (css) => {
  const match = /rgba?\(([^)]+)\)/.exec(css);
  if (!match) return null;
  const parts = match[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number);
  return { rgb: parts.slice(0, 3), alpha: parts.length > 3 ? parts[3] : 1 };
};
// CSS saturate(s) on sRGB values.
const saturate = ([r, g, b], s) =>
  [
    (0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * g + (0.072 - 0.072 * s) * b,
    (0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * g + (0.072 - 0.072 * s) * b,
    (0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * g + (0.072 + 0.928 * s) * b,
  ].map((v) => Math.min(255, Math.max(0, v)));

(() => {
  "use strict";

  const COLUMNS = 32;
  const ROWS = 32;

  /** What to check: a text element's selector and what kind of text it is. */
  const TEXTS = [
    { selector: ".row.on .title", kind: "ink" },
    { selector: ".row:not(.on) .title", kind: "muted" },
    { selector: ".row .meta", kind: "subtle" },
    { selector: ".tab.on", kind: "ink" },
    { selector: ".tab:not(.on)", kind: "subtle" },
    { selector: ".head-title", kind: "ink" },
    { selector: ".head-meta", kind: "muted" },
    { selector: ".you", kind: "ink" },
    { selector: ".agent p", kind: "ink" },
    { selector: ".log-row", kind: "muted" },
    { selector: ".log-head", kind: "subtle" },
    { selector: ".pill", kind: "ink" },
    { selector: ".field", kind: "subtle" },
  ];

  /** The fills between the scene and a text element, outermost first, and the glass's filter. */
  function layers(element) {
    const fills = [];
    let blur = 0;
    let sat = 1;
    for (let node = element; node && node.id !== "app"; node = node.parentElement) {
      const style = getComputedStyle(node);
      const fill = parse(style.backgroundColor);
      if (fill && fill.alpha > 0) fills.unshift(fill);
      const filter = style.backdropFilter || style.webkitBackdropFilter || "";
      const b = /blur\(([\d.]+)px\)/.exec(filter);
      const s = /saturate\(([\d.]+)\)/.exec(filter);
      if (b) blur = Number(b[1]);
      if (s) sat = Number(s[1]);
    }
    return { fills, blur, sat };
  }

  /** The scene grid averaged over a radius of cells, as the glass's blur would see it. */
  function blurred(grid, column, row, radius) {
    const sum = [0, 0, 0];
    let count = 0;
    for (let y = Math.max(0, row - radius); y <= Math.min(ROWS - 1, row + radius); y += 1)
      for (
        let x = Math.max(0, column - radius);
        x <= Math.min(COLUMNS - 1, column + radius);
        x += 1
      ) {
        const i = (y * COLUMNS + x) * 4;
        sum[0] += grid[i];
        sum[1] += grid[i + 1];
        sum[2] += grid[i + 2];
        count += 1;
      }
    return sum.map((v) => v / count);
  }

  /** Worst contrast per checked text, from one sample of the scene. */
  function report(grid, frame) {
    const box = frame.getBoundingClientRect();
    const cellW = box.width / COLUMNS;
    const cellH = box.height / ROWS;
    const results = [];
    for (const { selector, kind } of TEXTS) {
      let worst = Infinity;
      for (const element of document.querySelectorAll(selector)) {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0) continue;
        const text = parse(getComputedStyle(element).color);
        const { fills, blur, sat } = layers(element);
        // the blur's reach in cells (a Gaussian's visible spread is about twice its radius)
        const radius =
          blur > 0 ? Math.max(1, Math.round((blur * 1.5) / Math.min(cellW, cellH))) : 0;
        const c0 = Math.max(0, Math.floor((rect.left - box.left) / cellW));
        const c1 = Math.min(COLUMNS - 1, Math.floor((rect.right - box.left) / cellW));
        const r0 = Math.max(0, Math.floor((rect.top - box.top) / cellH));
        const r1 = Math.min(ROWS - 1, Math.floor((rect.bottom - box.top) / cellH));
        for (let row = r0; row <= r1; row += 1)
          for (let column = c0; column <= c1; column += 1) {
            let back =
              radius > 0
                ? saturate(blurred(grid, column, row, radius), sat)
                : blurred(grid, column, row, 0);
            for (const fill of fills) back = over(fill.rgb, fill.alpha, back);
            const fore = over(text.rgb, text.alpha, back);
            worst = Math.min(worst, ratio(fore, back));
          }
      }
      if (worst !== Infinity)
        results.push({ text: selector, kind, contrast: Math.round(worst * 100) / 100 });
    }
    return results;
  }

  window.galleryContrast = { report, columns: COLUMNS, rows: ROWS };
})();
