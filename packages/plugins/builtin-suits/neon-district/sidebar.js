// Neon District, the sidebar's own scene: rain running down a dark window, with one magenta and
// one cyan tube glowing along the inner edge. The glass and the tubes' halo are painted once on
// init and resize; a frame blits them and moves only the droplets and a slow hum in the tubes.
//
// Signals are moods: working quickens the rain, waiting warms the cyan tube for a moment, failed
// stutters both tubes, and a merged pull request runs a bright pulse down them.

const magenta = "#FF2D95";
const cyan = "#3DF2FF";
const amber = "#FFB547";
const maxDrops = 90;

let ctx = null;
let glass = null;
let width = 0;
let height = 0;
let ratio = 1;
let still = false;
// Scene time of the last frame: signals are stamped on ace's clock, not the wall's.
let last = 0;

let workingAt = -Infinity;
let waitingAt = -Infinity;
let failedAt = -Infinity;
let mergedAt = -Infinity;

const dropX = new Float32Array(maxDrops);
const dropY = new Float32Array(maxDrops);
const dropR = new Float32Array(maxDrops);
const dropSpeed = new Float32Array(maxDrops);
let drops = 0;

let seed = 613;
function random() {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
}

function surface(w, h) {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(w, h);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

function paintGlass() {
  glass = surface(Math.round(width * ratio), Math.round(height * ratio));
  const g = glass.getContext("2d", { alpha: false });
  g.setTransform(ratio, 0, 0, ratio, 0, 0);
  const fall = g.createLinearGradient(0, 0, 0, height);
  fall.addColorStop(0, "#07060D");
  fall.addColorStop(0.6, "#0B0814");
  fall.addColorStop(1, "#140A1C");
  g.fillStyle = fall;
  g.fillRect(0, 0, width, height);
  // A faint city glow low in the window.
  const glow = g.createRadialGradient(
    width * 0.5,
    height * 1.05,
    10,
    width * 0.5,
    height,
    height * 0.6,
  );
  glow.addColorStop(0, "rgba(255, 45, 149, 0.16)");
  glow.addColorStop(1, "rgba(255, 45, 149, 0)");
  g.fillStyle = glow;
  g.fillRect(0, 0, width, height);
}

function seedDrops() {
  seed = 613;
  drops = Math.min(maxDrops, Math.round((width * height) / 4200));
  for (let i = 0; i < drops; i++) {
    dropX[i] = random() * width;
    dropY[i] = random() * height;
    dropR[i] = 0.6 + random() * 1.6;
    dropSpeed[i] = 10 + random() * 40;
  }
}

function setup(view) {
  ctx = view.canvas.getContext("2d", { alpha: false });
  width = view.width;
  height = view.height;
  ratio = Math.min(2, view.pixelRatio);
  still = view.reduceMotion;
  paintGlass();
  seedDrops();
}

const since = (time, at) => (time - at) / 1000;

function tube(x, colour, strength) {
  ctx.globalAlpha = 0.12 * strength;
  ctx.fillStyle = colour;
  ctx.fillRect(x - 6, 0, 12, height);
  ctx.globalAlpha = 0.85 * strength;
  ctx.fillRect(x - 1, 0, 2, height);
  ctx.globalAlpha = 1;
}

function draw(time) {
  if (!ctx || !glass) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(glass, 0, 0);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

  const hum = still ? 1 : 0.85 + 0.15 * Math.sin(time / 900);
  const stutter = since(time, failedAt) < 0.6 && Math.floor(time / 60) % 2 === 0 ? 0.25 : 1;
  const warm = since(time, waitingAt) < 1.2;
  tube(width - 3, magenta, hum * stutter);
  tube(width - 11, warm ? amber : cyan, 0.7 * hum * stutter);

  const pulse = since(time, mergedAt);
  if (pulse >= 0 && pulse < 1.4) {
    const y = (pulse / 1.4) * height;
    ctx.globalAlpha = 0.5 * (1 - pulse / 1.4);
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(width - 14, y - 40, 14, 80);
    ctx.globalAlpha = 1;
  }

  const quick = since(time, workingAt) < 4 ? 2 : 1;
  ctx.fillStyle = "rgba(190, 220, 255, 0.22)";
  for (let i = 0; i < drops; i++) {
    const y = still ? dropY[i] : (dropY[i] + (time / 1000) * dropSpeed[i] * quick) % (height + 20);
    ctx.fillRect(dropX[i], y, dropR[i], dropR[i] * 3);
  }
}

ace.scene({
  init: setup,
  resize: setup,
  frame(time) {
    last = time;
    draw(time);
  },
  motion(reduceMotion) {
    still = reduceMotion;
  },
  signal(name) {
    const now = last;
    if (name === "working") workingAt = now;
    else if (name === "waiting") waitingAt = now;
    else if (name === "failed") failedAt = now;
    else if (name === "pr-merged") mergedAt = now;
  },
});
