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
let glow = null;
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
const mothTones = ["#c2a77e", "#b39470", "#d1bc96"];
const mothHind = "#e2d2b0";

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
    kind[i] = random() < 0.28 ? 1 : 0;
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

/** A firefly's glow, painted once: a soft yellow-green halo round a bright core. */
function paintGlow() {
  glow = document.createElement("canvas");
  glow.width = 64;
  glow.height = 64;
  const paint = glow.getContext("2d");
  if (!paint) return;
  const halo = paint.createRadialGradient(32, 32, 0, 32, 32, 32);
  halo.addColorStop(0, "rgba(255, 246, 200, 1)");
  halo.addColorStop(0.08, "rgba(255, 236, 160, 0.95)");
  halo.addColorStop(0.16, "rgba(255, 226, 140, 0.5)");
  halo.addColorStop(0.45, "rgba(214, 220, 110, 0.18)");
  halo.addColorStop(1, "rgba(214, 220, 110, 0)");
  paint.fillStyle = halo;
  paint.fillRect(0, 0, 64, 64);
}

function firefly(x, y, s, bright) {
  if (!glow) return;
  const r = 14 * s;
  ctx.globalAlpha = Math.min(1, bright);
  ctx.drawImage(glow, x - r, y - r, r * 2, r * 2);
}

function petal(x, y, s, turn, tone, alpha) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(turn);
  ctx.globalAlpha = alpha * 0.7;
  ctx.fillStyle = tone;
  ctx.beginPath();
  ctx.moveTo(0, -6 * s);
  ctx.quadraticCurveTo(5 * s, -1 * s, 0, 6 * s);
  ctx.quadraticCurveTo(-5 * s, -1 * s, 0, -6 * s);
  ctx.fill();
  ctx.restore();
}

/**
 * A small moth seen from above: swept triangular forewings over rounded hindwings, a darker
 * edge on each, and a slim body. `beat` folds the wings toward the body and out again.
 */
function moth(x, y, s, beat, tone, alpha) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.sin(beat * 0.25) * 0.25);
  ctx.globalAlpha = alpha * 0.92;
  const open = 0.3 + 0.7 * Math.abs(Math.sin(beat));
  ctx.lineWidth = 0.6;
  ctx.strokeStyle = "rgba(74, 58, 40, 0.55)";
  for (let side = -1; side <= 1; side += 2) {
    const w = side * open * s;
    // Hindwing, under the forewing.
    ctx.fillStyle = mothHind;
    ctx.beginPath();
    ctx.moveTo(0, 0.6 * s);
    ctx.quadraticCurveTo(w * 4.6, 1.2 * s, w * 3.4, 4.2 * s);
    ctx.quadraticCurveTo(w * 1.2, 4.6 * s, 0, 2.4 * s);
    ctx.fill();
    // Forewing: from the shoulder out to a swept tip, back along the trailing edge.
    ctx.fillStyle = tone;
    ctx.beginPath();
    ctx.moveTo(0, -1.6 * s);
    ctx.quadraticCurveTo(w * 4.2, -3.4 * s, w * 7.4, -0.4 * s);
    ctx.quadraticCurveTo(w * 5.2, 2.6 * s, 0, 1.4 * s);
    ctx.fill();
    ctx.stroke();
    // A darker spot on each forewing.
    ctx.fillStyle = "rgba(74, 58, 40, 0.45)";
    ctx.beginPath();
    ctx.arc(w * 3.6, -0.5 * s, 0.7 * s, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "#5a4630";
  ctx.beginPath();
  ctx.ellipse(0, 0.6 * s, 0.75 * s, 3.2 * s, 0, 0, Math.PI * 2);
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
      moth(x, y, size[i] * 1.7, phase[i] + t * 15, mothTones[i % mothTones.length], seen);
    } else {
      petal(x, y, size[i] * 1.2, phase[i] + t * 1.6, petalTones[i % petalTones.length], seen);
    }
  }
  ctx.globalAlpha = 1;
}

ace.scene({
  init(view) {
    paintGlow();
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
