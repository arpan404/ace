// Field Journal's celebration: a moment of life lifting off the page, above ace for under four
// seconds after a turn is done or a pull request merges.
//
// By lamplight (dark) a swarm of fireflies rises from the lower edge, each blinking in its own
// rhythm, and fades. On paper (light) a flutter of small moths and pressed-flower petals drifts up
// and across, wings beating, and fades. A merged pull request brings a fuller swarm than a done
// turn. The canvas stays transparent everywhere nothing flies, and everything has faded by 3.6 s.
// Everything is allocated in init and resize; frame only moves numbers and draws.

const most = 64;
const lifeMs = 3600;

let ctx = null;
let width = 1;
let height = 1;
let ratio = 1;
let scheme = "light";
let still = false;
let now = 0;
let startAt = 0;
// The scene clock is shared, so a flight starts on the first frame after launch, not at time 0.
let waiting = true;
let count = 40;

const px = new Float32Array(most);
const py = new Float32Array(most);
const vx = new Float32Array(most);
const vy = new Float32Array(most);
const size = new Float32Array(most);
const phase = new Float32Array(most);
const delay = new Float32Array(most);
const kind = new Uint8Array(most); // 0 petal, 1 moth (light); fireflies ignore it

const petalTones = ["#d98f8a", "#e6b45c", "#b9a0d6", "#e8a2b4", "#c7d68f"];
const mothTones = ["#8a7258", "#a08566", "#7a6a55"];

let seed = 19;
function random() {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
}

function launch(signal) {
  seed = signal === "pr-merged" ? 23 : 19;
  count = signal === "pr-merged" ? most : 40;
  waiting = true;
  for (let i = 0; i < most; i++) {
    px[i] = random();
    py[i] = 0.75 + random() * 0.4;
    vx[i] = (random() - 0.5) * 0.06;
    vy[i] = -(0.08 + random() * 0.16);
    size[i] = 0.6 + random() * 0.8;
    phase[i] = random() * Math.PI * 2;
    delay[i] = random() * 900;
    kind[i] = random() < 0.35 ? 1 : 0;
  }
}

function fit(view) {
  if (typeof view.reduceMotion === "boolean") still = view.reduceMotion;
  if (view.scheme === "light" || view.scheme === "dark") scheme = view.scheme;
  width = Math.max(1, view.width);
  height = Math.max(1, view.height);
  ratio = Math.min(2, view.pixelRatio || 1);
  view.canvas.width = Math.max(1, Math.round(width * ratio));
  view.canvas.height = Math.max(1, Math.round(height * ratio));
  ctx = view.canvas.getContext("2d");
}

/** How visible one flier is at `age` ms of its own flight: in over 300 ms, out by the end. */
function presence(age) {
  if (age <= 0) return 0;
  const left = lifeMs - 400 - age;
  return Math.max(0, Math.min(1, age / 300, left / 900));
}

function firefly(x, y, s, glow) {
  const halo = ctx.createRadialGradient(x, y, 0, x, y, 14 * s);
  halo.addColorStop(0, `rgba(255, 226, 140, ${0.55 * glow})`);
  halo.addColorStop(0.35, `rgba(214, 220, 110, ${0.22 * glow})`);
  halo.addColorStop(1, "rgba(214, 220, 110, 0)");
  ctx.fillStyle = halo;
  ctx.fillRect(x - 14 * s, y - 14 * s, 28 * s, 28 * s);
  ctx.fillStyle = `rgba(255, 246, 200, ${0.95 * glow})`;
  ctx.beginPath();
  ctx.arc(x, y, 1.6 * s, 0, Math.PI * 2);
  ctx.fill();
}

function petal(x, y, s, turn, tone, alpha) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(turn);
  ctx.globalAlpha = alpha * 0.85;
  ctx.fillStyle = tone;
  ctx.beginPath();
  ctx.moveTo(0, -6 * s);
  ctx.quadraticCurveTo(5 * s, -1 * s, 0, 6 * s);
  ctx.quadraticCurveTo(-5 * s, -1 * s, 0, -6 * s);
  ctx.fill();
  ctx.restore();
}

function moth(x, y, s, beat, tone, alpha) {
  ctx.save();
  ctx.translate(x, y);
  ctx.globalAlpha = alpha * 0.9;
  ctx.fillStyle = tone;
  // Wings: two pairs of ovals whose width beats, as if seen from above.
  const open = 0.35 + 0.65 * Math.abs(Math.sin(beat));
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(
      side * 4.5 * s * open,
      -1.5 * s,
      4.5 * s * open,
      3.6 * s,
      side * 0.5,
      0,
      Math.PI * 2,
    );
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(side * 3.2 * s * open, 3 * s, 3 * s * open, 2.4 * s, side * -0.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "#4a3c2c";
  ctx.beginPath();
  ctx.ellipse(0, 0.5 * s, 1.1 * s, 4.2 * s, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function draw() {
  if (!ctx) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (still) return;
  const elapsed = now - startAt;
  if (elapsed > lifeMs) return;
  for (let i = 0; i < count; i++) {
    const age = elapsed - delay[i];
    const seen = presence(age);
    if (seen <= 0) continue;
    const t = age / 1000;
    const wander = Math.sin(phase[i] + t * 2.1) * 18;
    const x = px[i] * width + vx[i] * width * t + wander;
    const y = py[i] * height + vy[i] * height * t;
    if (scheme === "dark") {
      const blink = 0.45 + 0.55 * Math.max(0, Math.sin(phase[i] + t * 4.2));
      firefly(x, y, size[i], seen * blink);
    } else if (kind[i] === 1) {
      moth(x, y, size[i] * 1.3, phase[i] + t * 16, mothTones[i % mothTones.length], seen);
    } else {
      petal(x, y, size[i] * 1.2, phase[i] + t * 1.6, petalTones[i % petalTones.length], seen);
    }
  }
  ctx.globalAlpha = 1;
}

ace.scene({
  init(view) {
    fit(view);
    launch("done");
  },
  frame(time, view) {
    now = time;
    if (waiting) {
      startAt = time;
      waiting = false;
    }
    if (view && typeof view.reduceMotion === "boolean") still = view.reduceMotion;
    draw();
  },
  signal(name) {
    if (name === "done" || name === "pr-merged") launch(name);
  },
  resize(view) {
    fit(view);
  },
  scheme(next) {
    if (next === "light" || next === "dark") scheme = next;
  },
  motion(reduceMotion) {
    still = reduceMotion;
  },
});
