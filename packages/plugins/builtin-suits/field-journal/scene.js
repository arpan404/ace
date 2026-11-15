// Field Journal: dappled light falling on a notebook through leaves overhead.
//
// The scene is drawn a little small (one canvas pixel per `grain` CSS px) and the browser
// stretches it, so every leaf shadow and fleck of sun comes out soft without any blur filter.
// Paper is the base, with three things pressed into its right margin as vector shapes (never
// images, so the live check can read the canvas): a fern frond hanging from the top corner, an
// oak leaf lower down and a small compass rose at the bottom. Over them sit two layers of leaf shadow that
// sway on a slow breeze, and sun flecks that breathe between them. In the dark scheme the page lies under a reading lamp: a warm pool of light from
// the upper left, the same leaves as faint shadows at its edge.
//
// Signals are a mood, never state: working stirs the breeze for a few seconds, done and a merged
// pull request let a little more sun through, failed passes a cloud over, waiting holds still.
// Everything is allocated in init and resize; frame only moves numbers and draws.

const grain = 3; // CSS px per canvas pixel
const leafCount = 22;
const fleckCount = 26;

const paper = {
  light: {
    base: "#f4eddc",
    shade: "rgba(92, 104, 62, ",
    sun: "rgba(255, 250, 232, ",
    fern: "rgba(125, 148, 97, 0.62)",
    fernEdge: "rgba(93, 115, 70, 0.7)",
    stem: "rgba(107, 83, 56, 0.8)",
    oak: "rgba(190, 128, 62, 0.55)",
    vein: "rgba(122, 74, 36, 0.6)",
    ink: "rgba(107, 83, 56, ",
  },
  dark: {
    base: "#1e1a14",
    shade: "rgba(8, 6, 3, ",
    sun: "rgba(255, 196, 120, ",
    fern: "rgba(157, 181, 124, 0.42)",
    fernEdge: "rgba(157, 181, 124, 0.5)",
    stem: "rgba(205, 184, 148, 0.5)",
    oak: "rgba(201, 147, 90, 0.36)",
    vein: "rgba(205, 184, 148, 0.4)",
    ink: "rgba(205, 184, 148, ",
  },
};

// The pressed pieces, as SVG path data (drawn by the Suit's own art script, in CSS px).
const pressedPaths = {
  fernLeaves:
    "M143.8 3.2Q142.1 19.6 154.6 30.4Q156.3 14 143.8 3.2ZM143.8 3.2Q131.2 -7.3 115.3 -3Q127.9 7.5 143.8 3.2ZM139 8.9Q137.6 24.4 149.4 34.5Q150.9 19 139 8.9ZM139 8.9Q127 -1 112 3.1Q124 13 139 8.9ZM134.2 14.7Q132.8 29.4 144.1 38.9Q145.4 24.2 134.2 14.7ZM134.2 14.7Q122.8 5.4 108.6 9.4Q120 18.7 134.2 14.7ZM129.2 20.8Q128 34.6 138.6 43.4Q139.8 29.7 129.2 20.8ZM129.2 20.8Q118.4 12.1 105.1 15.9Q115.9 24.6 129.2 20.8ZM124 27Q123 39.9 133 48.2Q134 35.3 124 27ZM124 27Q113.9 18.9 101.5 22.6Q111.6 30.7 124 27ZM118.8 33.5Q117.9 45.5 127.2 53.2Q128.1 41.1 118.8 33.5ZM118.8 33.5Q109.3 26 97.8 29.4Q107.2 36.9 118.8 33.5ZM113.5 40.1Q112.7 51.3 121.3 58.4Q122.1 47.2 113.5 40.1ZM113.5 40.1Q104.7 33.2 93.9 36.5Q102.7 43.4 113.5 40.1ZM108 47Q107.3 57.3 115.3 63.8Q116 53.5 108 47ZM108 47Q99.9 40.7 90 43.7Q98.1 50 108 47ZM102.4 54.1Q101.8 63.5 109.2 69.4Q109.8 60 102.4 54.1ZM102.4 54.1Q95 48.3 85.9 51.1Q93.4 56.9 102.4 54.1ZM96.7 61.3Q96.2 69.9 102.9 75.2Q103.4 66.7 96.7 61.3ZM96.7 61.3Q89.9 56.1 81.8 58.7Q88.6 63.9 96.7 61.3ZM90.9 68.8Q90.5 76.5 96.5 81.2Q96.9 73.5 90.9 68.8ZM90.9 68.8Q84.8 64.1 77.5 66.5Q83.6 71.1 90.9 68.8ZM85 76.5Q84.6 83.2 90 87.4Q90.3 80.6 85 76.5ZM85 76.5Q79.6 72.4 73.1 74.4Q78.5 78.5 85 76.5ZM79 84.3Q78.7 90.2 83.3 93.9Q83.6 88 79 84.3ZM79 84.3Q74.2 80.8 68.6 82.6Q73.3 86.2 79 84.3ZM72.8 92.4Q72.6 97.4 76.5 100.5Q76.8 95.5 72.8 92.4ZM72.8 92.4Q68.8 89.4 64 91Q68 94 72.8 92.4ZM66.5 100.7Q66.4 104.8 69.6 107.4Q69.8 103.2 66.5 100.7ZM66.5 100.7Q63.2 98.2 59.3 99.5Q62.6 102 66.5 100.7Z",
  fernStem: "M150 -4Q112 40 58 112",
  oakOutline:
    "M0 -0L1.6 -1.6L3.1 -3.2L4.7 -4.8L6.2 -6.4L7.7 -8L9.1 -9.6L10.2 -11.2L11.1 -12.8L11.6 -14.4L11.7 -16L11.5 -17.6L11 -19.2L10.2 -20.8L11.1 -22.4L13.1 -24L14.9 -25.6L16.6 -27.2L18 -28.8L19 -30.4L19.6 -32L19.8 -33.6L19.4 -35.2L18.7 -36.8L17.5 -38.4L16 -40L14.3 -41.6L13.7 -43.2L15.6 -44.8L17.3 -46.4L18.7 -48L19.7 -49.6L20.3 -51.2L20.5 -52.8L20.1 -54.4L19.4 -56L18.2 -57.6L16.7 -59.2L14.9 -60.8L13 -62.4L11.1 -64L12.3 -65.6L13.2 -67.2L14 -68.8L14.3 -70.4L14.4 -72L14 -73.6L13.3 -75.2L12.3 -76.8L11.1 -78.4L9.7 -80L8.2 -81.6L6.8 -83.2L5.3 -84.8L4.9 -86.4L4.8 -88L4.4 -89.6L3.8 -91.2L2.9 -92.8L1.7 -94.4L0 -96L-0 -96L-1.7 -94.4L-2.9 -92.8L-3.8 -91.2L-4.4 -89.6L-4.8 -88L-4.9 -86.4L-5.3 -84.8L-6.8 -83.2L-8.2 -81.6L-9.7 -80L-11.1 -78.4L-12.3 -76.8L-13.3 -75.2L-14 -73.6L-14.4 -72L-14.3 -70.4L-14 -68.8L-13.2 -67.2L-12.3 -65.6L-11.1 -64L-13 -62.4L-14.9 -60.8L-16.7 -59.2L-18.2 -57.6L-19.4 -56L-20.1 -54.4L-20.5 -52.8L-20.3 -51.2L-19.7 -49.6L-18.7 -48L-17.3 -46.4L-15.6 -44.8L-13.7 -43.2L-14.3 -41.6L-16 -40L-17.5 -38.4L-18.7 -36.8L-19.4 -35.2L-19.8 -33.6L-19.6 -32L-19 -30.4L-18 -28.8L-16.6 -27.2L-14.9 -25.6L-13.1 -24L-11.1 -22.4L-10.2 -20.8L-11 -19.2L-11.5 -17.6L-11.7 -16L-11.6 -14.4L-11.1 -12.8L-10.2 -11.2L-9.1 -9.6L-7.7 -8L-6.2 -6.4L-4.7 -4.8L-3.1 -3.2L-1.6 -1.6L-0 -0Z",
  oakVeins:
    "M0 6L0 -94M0 -12.5Q-8 -18.5 -16 -24.5M0 -12.5Q8 -18.5 16 -24.5M0 -30.9Q-8 -36.9 -15 -42.9M0 -30.9Q8 -36.9 15 -42.9M0 -49.4Q-8 -55.4 -14.1 -61.4M0 -49.4Q8 -55.4 14.1 -61.4M0 -67.8Q-8 -73.8 -13.1 -79.8M0 -67.8Q8 -73.8 13.1 -79.8",
  compassFill:
    "M0 0L-5 -0L0 -34ZM0 0L-3.5 -3.5L14.1 -14.1ZM0 0L0 -5L34 0ZM0 0L3.5 -3.5L14.1 14.1ZM0 0L5 0L0 34ZM0 0L3.5 3.5L-14.1 14.1ZM0 0L0 5L-34 0ZM0 0L-3.5 3.5L-14.1 -14.1Z",
  compassLine:
    "M0 0L5 0L0 -34ZM0 0L3.5 3.5L14.1 -14.1ZM0 0L0 5L34 0ZM0 0L-3.5 3.5L14.1 14.1ZM0 0L-5 0L0 34ZM0 0L-3.5 -3.5L-14.1 14.1ZM0 0L-0 -5L-34 0ZM0 0L3.5 -3.5L-14.1 -14.1Z",
  compassTicks:
    "M39 0L43 0M39.7 7.9L42.2 8.4M37.4 15.5L39.7 16.5M33.7 22.5L35.8 23.9M27.6 27.6L30.4 30.4M22.5 33.7L23.9 35.8M15.5 37.4L16.5 39.7M7.9 39.7L8.4 42.2M0 39L0 43M-7.9 39.7L-8.4 42.2M-15.5 37.4L-16.5 39.7M-22.5 33.7L-23.9 35.8M-27.6 27.6L-30.4 30.4M-33.7 22.5L-35.8 23.9M-37.4 15.5L-39.7 16.5M-39.7 7.9L-42.2 8.4M-39 0L-43 0M-39.7 -7.9L-42.2 -8.4M-37.4 -15.5L-39.7 -16.5M-33.7 -22.5L-35.8 -23.9M-27.6 -27.6L-30.4 -30.4M-22.5 -33.7L-23.9 -35.8M-15.5 -37.4L-16.5 -39.7M-7.9 -39.7L-8.4 -42.2M-0 -39L-0 -43M7.9 -39.7L8.4 -42.2M15.5 -37.4L16.5 -39.7M22.5 -33.7L23.9 -35.8M27.6 -27.6L30.4 -30.4M33.7 -22.5L35.8 -23.9M37.4 -15.5L39.7 -16.5M39.7 -7.9L42.2 -8.4",
};
let pressed = null;

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

/** Path2D from the path data, once; a page without Path2D just goes without the pressed pieces. */
function makePressed() {
  if (pressed || typeof Path2D !== "function") return;
  pressed = {};
  for (const key of Object.keys(pressedPaths)) pressed[key] = new Path2D(pressedPaths[key]);
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

/** The fern, the oak leaf and the compass rose, pressed into the page's corners. */
function drawPressed(ink) {
  if (!pressed) return;
  const unit = 1 / grain;
  ctx.save();
  // Fern: its 150 x 130 box, a third larger, hangs from the top right corner.
  ctx.setTransform(unit * 1.35, 0, 0, unit * 1.35, (width - 196) * unit, -2 * unit);
  ctx.fillStyle = ink.fern;
  ctx.fill(pressed.fernLeaves);
  ctx.lineWidth = 0.7;
  ctx.strokeStyle = ink.fernEdge;
  ctx.stroke(pressed.fernLeaves);
  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  ctx.strokeStyle = ink.stem;
  ctx.stroke(pressed.fernStem);
  // Oak leaf: in the right margin, its stem toward the edge, leaning in.
  ctx.setTransform(unit, 0, 0, unit, (width - 34) * unit, (height * 0.6 + 40) * unit);
  ctx.rotate(-0.62);
  ctx.fillStyle = ink.oak;
  ctx.fill(pressed.oakOutline);
  ctx.lineWidth = 0.9;
  ctx.strokeStyle = ink.vein;
  ctx.stroke(pressed.oakVeins);
  // Compass rose: bottom right.
  ctx.setTransform(unit, 0, 0, unit, (width - 74) * unit, (height - 84) * unit);
  ctx.lineWidth = 0.9;
  ctx.strokeStyle = `${ink.ink}0.45)`;
  ctx.beginPath();
  ctx.arc(0, 0, 43, 0, Math.PI * 2);
  ctx.stroke();
  ctx.stroke(pressed.compassTicks);
  ctx.fillStyle = `${ink.ink}0.55)`;
  ctx.fill(pressed.compassFill);
  ctx.lineWidth = 0.8;
  ctx.strokeStyle = `${ink.ink}0.55)`;
  ctx.stroke(pressed.compassLine);
  ctx.restore();
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

  drawPressed(ink);

  // Leaf shadows, far layer first; the near layer sways more.
  for (let i = 0; i < leafCount; i++) {
    const depth = leafDepth[i];
    const sway = (0.004 + depth * 0.01) * breeze * calm;
    const phase = leafPhase[i] + t * 0.00042 * (0.6 + depth);
    const x = (leafX[i] + Math.sin(phase) * sway) * cols;
    const y = (leafY[i] + Math.cos(phase * 0.8) * sway * 0.6) * rows;
    const angle = leafAngle[i] + Math.sin(phase * 0.7) * 0.08 * breeze;
    const alpha = (scheme === "dark" ? 0.34 : 0.17) * (0.55 + depth * 0.45);
    leaf(x, y, leafSize[i] * span * (0.8 + depth * 0.5), angle, alpha, ink.shade);
  }

  // Sun flecks between the leaves, breathing in and out.
  const fleckAlpha = scheme === "dark" ? 0.05 : 0.7;
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
    makePressed();
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
