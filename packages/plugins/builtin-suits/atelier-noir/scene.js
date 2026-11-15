// Atelier Noir: black lacquer over pebbled leather, and a slow band of light that drifts across
// it like the sheen on a polished case. By day the same room in ivory paper with faint fibres.
// The grain is painted once per size into an offscreen canvas (a canvas, not an image, so the
// live check can still read the frame); each frame only blits it and lays the sheen on top.
// A finished turn sends one brighter gold glint across; nothing else reacts.

const period = 52000; // ms for the sheen to cross once
const glintMs = 1800;

let ctx = null;
let base = null;
let baseCtx = null;
let tile = null;
let width = 1;
let height = 1;
let scheme = "dark";
let still = false;
let now = 0;
let glintAt = -Infinity;

// A fixed seed: the grain is the same on every load, so a still frame never jumps.
let seed = 7;
function random() {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
}

const tones = {
  dark: {
    top: "#0f0d0b",
    bottom: "#090807",
    glow: "rgba(64, 52, 36, 0.22)",
    light: "rgba(255, 236, 200, ",
    pebbleLight: "rgba(255, 238, 210, 0.035)",
    pebbleDark: "rgba(0, 0, 0, 0.28)",
    stroke: "rgba(255, 230, 190, 0.018)",
    sheen: 0.05,
  },
  light: {
    top: "#f6f1e7",
    bottom: "#efe8da",
    glow: "rgba(255, 255, 250, 0.5)",
    light: "rgba(255, 253, 244, ",
    pebbleLight: "rgba(255, 255, 255, 0.22)",
    pebbleDark: "rgba(120, 96, 60, 0.035)",
    stroke: "rgba(120, 96, 60, 0.03)",
    sheen: 0.32,
  },
};

/** A 192 px tile of grain: pebbles of leather by night, short paper fibres by day. */
function paintTile() {
  const t = tones[scheme];
  if (!tile) tile = document.createElement("canvas");
  tile.width = 192;
  tile.height = 192;
  const g = tile.getContext("2d");
  g.clearRect(0, 0, 192, 192);
  seed = scheme === "dark" ? 7 : 19;
  if (scheme === "dark") {
    for (let i = 0; i < 900; i++) {
      const x = random() * 192;
      const y = random() * 192;
      const r = 0.8 + random() * 2.2;
      g.fillStyle = random() < 0.5 ? t.pebbleLight : t.pebbleDark;
      g.beginPath();
      g.ellipse(x, y, r, r * (0.6 + random() * 0.5), random() * Math.PI, 0, Math.PI * 2);
      g.fill();
    }
  } else {
    g.lineWidth = 0.6;
    for (let i = 0; i < 260; i++) {
      const x = random() * 192;
      const y = random() * 192;
      const a = random() * Math.PI;
      const l = 2 + random() * 6;
      g.strokeStyle = random() < 0.5 ? t.pebbleLight : t.pebbleDark;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
      g.stroke();
    }
  }
}

/** The still room: a deep gradient, a soft pool of light, the grain and a few lacquer strokes. */
function paintBase() {
  const t = tones[scheme];
  if (!base) base = document.createElement("canvas");
  base.width = Math.max(1, Math.ceil(width));
  base.height = Math.max(1, Math.ceil(height));
  baseCtx = base.getContext("2d");
  const g = baseCtx;
  const fall = g.createLinearGradient(0, 0, 0, height);
  fall.addColorStop(0, t.top);
  fall.addColorStop(1, t.bottom);
  g.fillStyle = fall;
  g.fillRect(0, 0, width, height);
  const pool = g.createRadialGradient(
    width * 0.28,
    height * 0.18,
    0,
    width * 0.28,
    height * 0.18,
    Math.max(width, height) * 0.8,
  );
  pool.addColorStop(0, t.glow);
  pool.addColorStop(1, "rgba(0, 0, 0, 0)");
  g.fillStyle = pool;
  g.fillRect(0, 0, width, height);
  paintTile();
  const pattern = g.createPattern(tile, "repeat");
  if (pattern) {
    g.fillStyle = pattern;
    g.fillRect(0, 0, width, height);
  }
  seed = 31;
  g.strokeStyle = t.stroke;
  g.lineWidth = 1;
  for (let i = 0; i < 40; i++) {
    const y = random() * height;
    const x = random() * width;
    g.beginPath();
    g.moveTo(x, y);
    g.bezierCurveTo(
      x + width * 0.2,
      y - height * 0.04,
      x + width * 0.4,
      y + height * 0.03,
      x + width * 0.6,
      y,
    );
    g.stroke();
  }
}

function size(view) {
  width = view.width;
  height = view.height;
  scheme = view.scheme === "light" ? "light" : "dark";
  if (typeof view.reduceMotion === "boolean") still = view.reduceMotion;
  // One canvas pixel per CSS pixel: the grain is soft by nature and sits under glass.
  view.canvas.width = Math.max(1, Math.ceil(width));
  view.canvas.height = Math.max(1, Math.ceil(height));
  ctx = view.canvas.getContext("2d", { alpha: false });
  paintBase();
}

/** A diagonal band of light centred `at` (0–1 across the window), `strength` its peak alpha. */
function band(at, strength, spread) {
  const span = width + height;
  const cx = -height * 0.5 + at * span;
  const g = ctx.createLinearGradient(cx - spread, 0, cx + spread, height * 0.6);
  const light = tones[scheme].light;
  g.addColorStop(0, light + "0)");
  g.addColorStop(0.5, light + strength.toFixed(3) + ")");
  g.addColorStop(1, light + "0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);
}

function draw(time) {
  if (!ctx || !base) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(base, 0, 0);
  const t = tones[scheme];
  const phase = still ? 0.34 : (time % period) / period;
  const spread = Math.max(width, height) * 0.22;
  // The sheen eases in and out at the window's edges, so it never pops.
  const edge = Math.sin(phase * Math.PI);
  band(phase * 1.3 - 0.15, t.sheen * edge, spread);
  band(((phase + 0.5) % 1) * 1.3 - 0.15, t.sheen * 0.45 * Math.sin(((phase + 0.5) % 1) * Math.PI), spread * 0.6);
  const since = time - glintAt;
  if (!still && since >= 0 && since < glintMs) {
    const p = since / glintMs;
    const fade = Math.sin(p * Math.PI);
    band(p * 1.2 - 0.1, (scheme === "dark" ? 0.09 : 0.4) * fade, spread * 0.35);
  }
}

ace.scene({
  init(view) {
    size(view);
  },
  resize(view) {
    size(view);
  },
  scheme(next) {
    scheme = next === "light" ? "light" : "dark";
    paintBase();
  },
  motion(reduceMotion) {
    still = reduceMotion;
  },
  frame(time, view) {
    now = time;
    if (typeof view.reduceMotion === "boolean") still = view.reduceMotion;
    draw(time);
  },
  signal(name) {
    if (name === "done" || name === "pr-merged") glintAt = now;
  },
});
