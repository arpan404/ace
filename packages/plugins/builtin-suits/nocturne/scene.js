// Nocturne: pale light drifting behind dark glass. Three soft pools of light (cool, cooler and a
// trace of warmth) wander on slow paths that take minutes to repeat. Each pool is a gradient
// sprite rendered once; the canvas is a quarter of the window's size, since the light has no
// edges to lose, and a tick redraws only once some pool has moved a visible amount.

const night = "#0B0C0F";
// Canvas pixels per CSS pixel: the light is soft enough to scale up without showing it.
const scale = 0.25;
// Redraw once a pool has moved this many canvas pixels.
const step = 0.35;
// Under Reduce motion the light holds where it is at this moment of its path.
const stillAt = 41000;

const pools = [
  { colour: [150, 168, 205], alpha: 0.26, size: 0.62, x: 0.6, y: 0.16, ax: 0.16, ay: 0.1, px: 173000, py: 131000, phase: 0.3 },
  { colour: [118, 150, 168], alpha: 0.18, size: 0.55, x: 0.84, y: 0.8, ax: 0.12, ay: 0.12, px: 211000, py: 157000, phase: 2.1 },
  { colour: [196, 170, 140], alpha: 0.1, size: 0.5, x: 0.38, y: 0.62, ax: 0.14, ay: 0.08, px: 241000, py: 193000, phase: 4.4 },
];

let view = null;
let ctx = null;
let width = 1;
let height = 1;
let still = false;
let last = 0;
const sprites = [];
const drawnX = new Float32Array(pools.length);
const drawnY = new Float32Array(pools.length);

function surface(w, h) {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(w, h);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

// One radial falloff per pool, eased so the light has no visible rim.
function sprite(pool) {
  const size = 128;
  const canvas = surface(size, size);
  const g = canvas.getContext("2d");
  const [r, gr, b] = pool.colour;
  const fall = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    const strength = pool.alpha * (1 - t) * (1 - t) * (1 - t * 0.35);
    fall.addColorStop(t, `rgba(${r}, ${gr}, ${b}, ${strength.toFixed(4)})`);
  }
  g.fillStyle = fall;
  g.fillRect(0, 0, size, size);
  return canvas;
}

function setup(next) {
  view = next;
  width = Math.max(1, Math.round(next.width * scale));
  height = Math.max(1, Math.round(next.height * scale));
  next.canvas.width = width;
  next.canvas.height = height;
  ctx = next.canvas.getContext("2d", { alpha: false });
  drawnX.fill(-1e6);
}

function place(pool, time, i) {
  const t = still ? stillAt : time;
  const tau = Math.PI * 2;
  drawnX[i] = (pool.x + pool.ax * Math.sin((t / pool.px) * tau + pool.phase)) * width;
  drawnY[i] = (pool.y + pool.ay * Math.sin((t / pool.py) * tau + pool.phase * 1.7)) * height;
}

function moved(time) {
  const tau = Math.PI * 2;
  const t = still ? stillAt : time;
  for (let i = 0; i < pools.length; i++) {
    const pool = pools[i];
    const x = (pool.x + pool.ax * Math.sin((t / pool.px) * tau + pool.phase)) * width;
    const y = (pool.y + pool.ay * Math.sin((t / pool.py) * tau + pool.phase * 1.7)) * height;
    if (Math.abs(x - drawnX[i]) >= step || Math.abs(y - drawnY[i]) >= step) return true;
  }
  return false;
}

function draw(time) {
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = night;
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = "lighter";
  const reach = Math.max(width, height);
  for (let i = 0; i < pools.length; i++) {
    place(pools[i], time, i);
    const size = reach * pools[i].size * 2;
    ctx.drawImage(sprites[i], drawnX[i] - size / 2, drawnY[i] - size / 2, size, size);
  }
  ctx.globalCompositeOperation = "source-over";
}

ace.scene({
  init(next) {
    still = next.reduceMotion;
    for (const pool of pools) sprites.push(sprite(pool));
    setup(next);
    draw(0);
  },
  frame(time) {
    last = time;
    if (moved(time)) draw(time);
  },
  resize(next) {
    setup(next);
    draw(last);
  },
  motion(reduce) {
    still = reduce;
    if (view) draw(last);
  },
  scheme() {
    // Dark only: the night stays the same.
  },
  signal() {
    // The light keeps its own slow time; ace's markers show what each agent is doing.
  },
});
