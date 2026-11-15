// Field Journal: dappled light falling on a notebook through leaves overhead.
//
// The scene is drawn small (one canvas pixel per `grain` CSS px) and the browser stretches it, so
// every leaf shadow and fleck of sun comes out soft without any blur filter. Paper is the base;
// over it sit two layers of leaf shadow that sway on a slow breeze, and sun flecks that breathe
// between them. In the dark scheme the page lies under a reading lamp: a warm pool of light from
// the upper left, the same leaves as faint shadows at its edge.
//
// Signals are a mood, never state: working stirs the breeze for a few seconds, done and a merged
// pull request let a little more sun through, failed passes a cloud over, waiting holds still.
// Everything is allocated in init and resize; frame only moves numbers and draws.

const grain = 6; // CSS px per canvas pixel
const leafCount = 22;
const fleckCount = 26;

const paper = {
  light: { base: "#f4eddc", shade: "rgba(92, 104, 62, ", sun: "rgba(255, 250, 232, " },
  dark: { base: "#1e1a14", shade: "rgba(8, 6, 3, ", sun: "rgba(255, 196, 120, " },
};

let ctx = null;
let width = 1;
let height = 1;
let cols = 1;
let rows = 1;
let scheme = "light";
let still = false;
let now = 0;

let breezeAt = -Infinity;
let sunAt = -Infinity;
let cloudAt = -Infinity;
let hushAt = -Infinity;

const leafX = new Float32Array(leafCount);
const leafY = new Float32Array(leafCount);
const leafSize = new Float32Array(leafCount);
const leafAngle = new Float32Array(leafCount);
const leafPhase = new Float32Array(leafCount);
const leafDepth = new Float32Array(leafCount);

const fleckX = new Float32Array(fleckCount);
const fleckY = new Float32Array(fleckCount);
const fleckSize = new Float32Array(fleckCount);
const fleckPhase = new Float32Array(fleckCount);

// A fixed seed keeps the canopy the same on every load, so a still frame never jumps.
let seed = 7;
function random() {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
}

function scatter() {
  seed = 7;
  for (let i = 0; i < leafCount; i++) {
    leafX[i] = random();
    leafY[i] = random();
    leafSize[i] = 0.06 + random() * 0.09;
    leafAngle[i] = random() * Math.PI * 2;
    leafPhase[i] = random() * Math.PI * 2;
    leafDepth[i] = random();
  }
  for (let i = 0; i < fleckCount; i++) {
    fleckX[i] = random();
    fleckY[i] = random();
    fleckSize[i] = 0.025 + random() * 0.05;
    fleckPhase[i] = random() * Math.PI * 2;
  }
}

function size(view) {
  if (typeof view.reduceMotion === "boolean") still = view.reduceMotion;
  if (view.scheme === "light" || view.scheme === "dark") scheme = view.scheme;
  width = Math.max(1, view.width);
  height = Math.max(1, view.height);
  cols = Math.max(1, Math.ceil(width / grain));
  rows = Math.max(1, Math.ceil(height / grain));
  view.canvas.width = cols;
  view.canvas.height = rows;
  ctx = view.canvas.getContext("2d", { alpha: false });
  if (ctx) ctx.imageSmoothingEnabled = true;
}

/** 0 → 1 → 0 over `span` ms after `at`, eased; 0 outside it. */
function swell(at, span) {
  const t = (now - at) / span;
  if (t < 0 || t > 1) return 0;
  return Math.sin(t * Math.PI);
}

/** A leaf's shadow: a pointed oval with a soft gradient falloff, in canvas pixels. */
function leaf(x, y, length, angle, alpha, tone) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  const half = length / 2;
  const fill = ctx.createRadialGradient(0, 0, 0, 0, 0, half);
  fill.addColorStop(0, `${tone}${alpha})`);
  fill.addColorStop(0.7, `${tone}${alpha * 0.6})`);
  fill.addColorStop(1, `${tone}0)`);
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(-half, 0);
  ctx.quadraticCurveTo(0, -half * 0.55, half, 0);
  ctx.quadraticCurveTo(0, half * 0.55, -half, 0);
  ctx.fill();
  ctx.restore();
}

function blob(x, y, radius, alpha, tone) {
  const fill = ctx.createRadialGradient(x, y, 0, x, y, radius);
  fill.addColorStop(0, `${tone}${alpha})`);
  fill.addColorStop(1, `${tone}0)`);
  ctx.fillStyle = fill;
  ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
}

function draw() {
  if (!ctx) return;
  const ink = paper[scheme];
  const t = still ? 0 : now;
  const breeze = 1 + 2.2 * swell(breezeAt, 5000);
  const sun = 1 + 0.6 * swell(sunAt, 2600) - 0.45 * swell(cloudAt, 3200);
  const calm = 1 - 0.5 * swell(hushAt, 2400);
  const span = Math.max(cols, rows);

  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = ink.base;
  ctx.fillRect(0, 0, cols, rows);

  if (scheme === "dark") {
    // The reading lamp: a warm pool from the upper left that breathes very slightly.
    const flicker = 1 + 0.03 * Math.sin(t * 0.0011) * calm;
    blob(cols * 0.18, rows * 0.08, span * 0.75 * flicker, 0.11 * sun, ink.sun);
    blob(cols * 0.3, rows * 0.25, span * 0.35, 0.05 * sun, ink.sun);
  }

  // Leaf shadows, far layer first; the near layer sways more.
  for (let i = 0; i < leafCount; i++) {
    const depth = leafDepth[i];
    const sway = (0.004 + depth * 0.01) * breeze * calm;
    const phase = leafPhase[i] + t * 0.00042 * (0.6 + depth);
    const x = (leafX[i] + Math.sin(phase) * sway) * cols;
    const y = (leafY[i] + Math.cos(phase * 0.8) * sway * 0.6) * rows;
    const angle = leafAngle[i] + Math.sin(phase * 0.7) * 0.08 * breeze;
    const alpha = (scheme === "dark" ? 0.32 : 0.075) * (0.55 + depth * 0.45);
    leaf(x, y, leafSize[i] * span * (0.8 + depth * 0.5), angle, alpha, ink.shade);
  }

  // Sun flecks between the leaves, breathing in and out.
  const fleckAlpha = scheme === "dark" ? 0.045 : 0.5;
  for (let i = 0; i < fleckCount; i++) {
    const breath = 0.55 + 0.45 * Math.sin(fleckPhase[i] + t * 0.0007 * breeze);
    const x = (fleckX[i] + Math.sin(fleckPhase[i] + t * 0.0003) * 0.006 * breeze) * cols;
    const y = fleckY[i] * rows;
    blob(x, y, fleckSize[i] * span, fleckAlpha * breath * sun, ink.sun);
  }
}

ace.scene({
  init(view) {
    scatter();
    size(view);
  },
  frame(time, view) {
    now = time;
    if (view && typeof view.reduceMotion === "boolean") still = view.reduceMotion;
    draw();
  },
  signal(name) {
    if (name === "working") breezeAt = now;
    else if (name === "done" || name === "pr-merged") sunAt = now;
    else if (name === "failed") cloudAt = now;
    else if (name === "waiting") hushAt = now;
  },
  resize(view) {
    size(view);
  },
  scheme(next) {
    if (next === "light" || next === "dark") scheme = next;
  },
  motion(reduceMotion) {
    still = reduceMotion;
  },
});
