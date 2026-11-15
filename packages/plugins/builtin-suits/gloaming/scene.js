// Gloaming: the sky just after sunset (just before sunrise by day). The sky's gradient is
// painted once per size and scheme into a layer; a warm glow low on the horizon breathes over
// a minute and drifts along it, and a band of high haze crosses slowly. The canvas is a quarter
// of the window's size, and a tick redraws only once something has changed visibly.

const skies = {
  dark: {
    stops: [
      [0, "#120F18"],
      [0.45, "#17131D"],
      [0.78, "#241A26"],
      [1, "#2E1F2A"],
    ],
    glow: [238, 158, 132],
    glowAlpha: 0.26,
    haze: [178, 160, 214],
    hazeAlpha: 0.045,
  },
  light: {
    stops: [
      [0, "#F6F2F5"],
      [0.5, "#F7F1F2"],
      [0.82, "#F8EAE6"],
      [1, "#F7E2DA"],
    ],
    glow: [244, 190, 160],
    glowAlpha: 0.3,
    haze: [206, 190, 222],
    hazeAlpha: 0.12,
  },
};
const scale = 0.25;
// Under Reduce motion the sky holds this moment.
const stillAt = 23000;
const breathMs = 64000;
const driftMs = 240000;
const hazeMs = 300000;

let view = null;
let ctx = null;
let width = 1;
let height = 1;
let scheme = "dark";
let still = false;
let last = 0;
let sky = null;
let glow = null;
let haze = null;

function surface(w, h) {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(w, h);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

function softSprite(colour, alpha) {
  const size = 128;
  const canvas = surface(size, size);
  const g = canvas.getContext("2d");
  const fall = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    const strength = alpha * (1 - t) * (1 - t);
    fall.addColorStop(t, `rgba(${colour[0]}, ${colour[1]}, ${colour[2]}, ${strength.toFixed(4)})`);
  }
  g.fillStyle = fall;
  g.fillRect(0, 0, size, size);
  return canvas;
}

function paintLayers() {
  const palette = skies[scheme];
  sky = surface(width, height);
  const g = sky.getContext("2d");
  const fade = g.createLinearGradient(0, 0, 0, height);
  for (const [at, colour] of palette.stops) fade.addColorStop(at, colour);
  g.fillStyle = fade;
  g.fillRect(0, 0, width, height);
  glow = softSprite(palette.glow, palette.glowAlpha);
  haze = softSprite(palette.haze, palette.hazeAlpha);
  shownBreath = -1;
}

function setup(next) {
  view = next;
  width = Math.max(1, Math.round(next.width * scale));
  height = Math.max(1, Math.round(next.height * scale));
  next.canvas.width = width;
  next.canvas.height = height;
  ctx = next.canvas.getContext("2d", { alpha: false });
  paintLayers();
}

// Where things are at `time`, kept in numbers (no allocation per tick).
let breath = 1;
let glowX = 0;
let hazeX = 0;
// What the canvas shows now, in steps a redraw would make visible; -1 forces a redraw.
let shownBreath = -1;
let shownGlow = -1;
let shownHaze = -1;

function measure(time) {
  const t = still ? stillAt : time;
  const tau = Math.PI * 2;
  breath = 0.82 + 0.18 * Math.sin((t / breathMs) * tau);
  glowX = (0.5 + 0.18 * Math.sin((t / driftMs) * tau)) * width;
  hazeX = (((t / hazeMs) % 1) * 1.6 - 0.3) * width;
}

function draw(time) {
  measure(time);
  const b = Math.round(breath * 200);
  const g = Math.round(glowX * 3);
  const h = Math.round(hazeX * 3);
  if (b === shownBreath && g === shownGlow && h === shownHaze) return;
  shownBreath = b;
  shownGlow = g;
  shownHaze = h;
  ctx.globalAlpha = 1;
  ctx.drawImage(sky, 0, 0);
  // The glow sits on the horizon, wide and low.
  const glowWidth = width * 1.3;
  const glowHeight = height * 0.9;
  ctx.globalAlpha = breath;
  ctx.drawImage(glow, glowX - glowWidth / 2, height * 1.02 - glowHeight / 2, glowWidth, glowHeight);
  // High haze: a long, thin band.
  const hazeWidth = width * 0.9;
  const hazeHeight = height * 0.22;
  ctx.globalAlpha = 1;
  ctx.drawImage(haze, hazeX - hazeWidth / 2, height * 0.24 - hazeHeight / 2, hazeWidth, hazeHeight);
}

ace.scene({
  init(next) {
    scheme = next.scheme === "light" ? "light" : "dark";
    still = next.reduceMotion;
    setup(next);
    draw(0);
  },
  frame(time) {
    last = time;
    draw(time);
  },
  resize(next) {
    setup(next);
    draw(last);
  },
  scheme(next) {
    scheme = next === "light" ? "light" : "dark";
    if (!view) return;
    paintLayers();
    draw(last);
  },
  motion(reduce) {
    still = reduce;
    shownBreath = -1;
    if (view) draw(last);
  },
  signal() {
    // The sky keeps its own slow time; ace's markers show what each agent is doing.
  },
});
