// Starfield: a slow drift of stars, with a short flare from the centre when a pull request
// merges. Everything is allocated in init and resize; frame only moves numbers and draws.

const sky = "#0A0F1E";
const maxStars = 260;
const sparks = 48;
const burstMs = 1400;

let ctx = null;
let width = 0;
let height = 0;
let ratio = 1;
let still = false;
let count = 0;
let last = -1;
let burstAt = -Infinity;

const starX = new Float32Array(maxStars);
const starY = new Float32Array(maxStars);
const depth = new Float32Array(maxStars);
const phase = new Float32Array(maxStars);
const sparkAngle = new Float32Array(sparks);
const sparkSpeed = new Float32Array(sparks);

// A fixed seed keeps the sky the same on every load, so a still frame never jumps.
let seed = 7;
function random() {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
}

function size(view) {
  if (typeof view.reduceMotion === "boolean") still = view.reduceMotion;
  width = view.width;
  height = view.height;
  ratio = Math.min(2, view.pixelRatio);
  view.canvas.width = Math.round(width * ratio);
  view.canvas.height = Math.round(height * ratio);
  ctx = view.canvas.getContext("2d", { alpha: false });
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  count = Math.max(60, Math.min(maxStars, Math.round((width * height) / 9000)));
}

function draw(time) {
  const dt = last < 0 ? 0 : Math.min(100, time - last);
  last = time;
  const since = time - burstAt;
  const burst = !still && since >= 0 && since < burstMs ? 1 - since / burstMs : 0;

  ctx.globalAlpha = 1;
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  // About 6 px a second for the nearest stars, a little faster while a flare lasts.
  const drift = (dt / 1000) * (6 + 30 * burst * burst);
  ctx.fillStyle = "#DCE6FF";
  for (let i = 0; i < count; i++) {
    let x = starX[i] - (drift * depth[i]) / width;
    if (x < 0) x += 1;
    starX[i] = x;
    const twinkle = still ? 1 : 0.75 + 0.25 * Math.sin(time / 900 + phase[i]);
    ctx.globalAlpha = (0.18 + 0.4 * depth[i]) * twinkle;
    const r = 0.6 + depth[i] * 1.1;
    ctx.fillRect(x * width, starY[i] * height, r, r);
  }

  if (burst > 0) {
    const cx = width / 2;
    const cy = height / 2;
    const reach = Math.min(width, height) * 0.45 * (1 - burst * burst * burst);
    ctx.fillStyle = "#80D8FE";
    for (let i = 0; i < sparks; i++) {
      const d = reach * sparkSpeed[i];
      ctx.globalAlpha = 0.5 * burst;
      ctx.fillRect(cx + Math.cos(sparkAngle[i]) * d, cy + Math.sin(sparkAngle[i]) * d, 1.6, 1.6);
    }
  }
}

ace.scene({
  init(view) {
    still = view.reduceMotion;
    for (let i = 0; i < maxStars; i++) {
      starX[i] = random();
      starY[i] = random();
      depth[i] = 0.3 + 0.7 * random() * random();
      phase[i] = random() * Math.PI * 2;
    }
    for (let i = 0; i < sparks; i++) {
      sparkAngle[i] = (i / sparks) * Math.PI * 2 + random() * 0.2;
      sparkSpeed[i] = 0.55 + 0.45 * random();
    }
    size(view);
  },
  frame(time) {
    draw(time);
  },
  resize(view) {
    size(view);
  },
  signal(name) {
    // A mood, not a state: ace's own markers show what each agent is doing.
    if (name === "pr-merged" && !still) burstAt = last < 0 ? 0 : last;
  },
  scheme() {
    // Dark only: the sky stays the same.
  },
});
