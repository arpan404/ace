// Starship Bridge's celebration: the jump. ace shows this frame above the UI for a moment when
// the open thread's run finishes or a pull request merges. Stars stretch into streaks racing out
// from a point ahead of the bow, a jump flash blooms and a ring of light rolls out to the window's
// edges, then the frame fades and says it is finished. A merge makes the full jump; a finished
// run makes a shorter, quieter one. The frame is clear wherever nothing is drawn; ace cuts holes
// around the approval strip, the Working line and status icons, and never plays this under
// Reduce motion. Streaks are allocated in init and resize; frame only moves numbers and draws.

const maxStreaks = 180;

let ctx = null;
let width = 0;
let height = 0;
let ratio = 1;
let dark = true;
let now = 0;
let startedAt = -1;
let full = true;
let over = false;

const angle = new Float32Array(maxStreaks);
const start = new Float32Array(maxStreaks);
const pace = new Float32Array(maxStreaks);
const warm = new Uint8Array(maxStreaks);
let count = 0;

let seed = 5;
function random() {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
}

function size(view) {
  width = Math.max(1, view.width);
  height = Math.max(1, view.height);
  ratio = Math.min(2, view.pixelRatio || 1);
  dark = view.scheme !== "light";
  ctx = view.canvas.getContext("2d");
  seed = 5;
  for (let i = 0; i < maxStreaks; i++) {
    angle[i] = random() * Math.PI * 2;
    start[i] = 0.02 + random() * 0.35;
    pace[i] = 0.6 + random() * 0.8;
    warm[i] = random() < 0.15 ? 1 : 0;
  }
}

const ease = (t) => t * t * t;
const clamp = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

// The timeline, in ms from the signal. A finished run's jump is shorter.
const timing = () =>
  full
    ? { streak: 1300, flash: 1300, flashFor: 520, ring: 2300, end: 2900, streaks: 180 }
    : { streak: 1000, flash: 1000, flashFor: 380, ring: 1700, end: 2200, streaks: 110 };

function drawStreaks(t, plan, cx, cy, reach, fade) {
  const run = clamp(t / plan.streak);
  const rush = ease(run); // the jump accelerates
  const alpha = clamp(t / 260) * fade;
  if (alpha <= 0) return;
  ctx.lineCap = "round";
  for (let tone = 0; tone < 2; tone++) {
    ctx.beginPath();
    for (let i = 0; i < plan.streaks; i++) {
      if (warm[i] !== tone) continue;
      const d = (start[i] + rush * pace[i] * 1.4) * reach;
      const length = 4 + rush * pace[i] * reach * 0.45;
      const ca = Math.cos(angle[i]);
      const sa = Math.sin(angle[i]);
      ctx.moveTo(cx + ca * d, cy + sa * d);
      ctx.lineTo(cx + ca * (d + length), cy + sa * (d + length));
    }
    const colour =
      tone === 1
        ? dark
          ? "255, 214, 160"
          : "150, 92, 20"
        : dark
          ? "190, 245, 250"
          : "0, 107, 118";
    ctx.strokeStyle = `rgba(${colour}, ${(alpha * 0.85).toFixed(3)})`;
    ctx.lineWidth = 1 + rush * 1.6;
    ctx.stroke();
  }
}

function drawFlash(t, plan, cx, cy, reach) {
  const local = (t - plan.flash) / plan.flashFor;
  if (local < 0 || local > 1) return;
  // A fast bloom and a slower decay.
  const strength = local < 0.18 ? local / 0.18 : 1 - (local - 0.18) / 0.82;
  const peak = (full ? 0.5 : 0.32) * strength;
  const bloom = ctx.createRadialGradient(cx, cy, 0, cx, cy, reach * (0.35 + local * 0.5));
  const core = dark ? "225, 252, 255" : "255, 255, 255";
  const edge = dark ? "63, 214, 226" : "0, 127, 140";
  bloom.addColorStop(0, `rgba(${core}, ${peak.toFixed(3)})`);
  bloom.addColorStop(0.4, `rgba(${edge}, ${(peak * 0.35).toFixed(3)})`);
  bloom.addColorStop(1, `rgba(${edge}, 0)`);
  ctx.fillStyle = bloom;
  ctx.fillRect(0, 0, width, height);
  // The flare: one thin line of light across the window through the jump point.
  const flare = ctx.createLinearGradient(0, cy, width, cy);
  flare.addColorStop(0, `rgba(${edge}, 0)`);
  flare.addColorStop(0.5, `rgba(${core}, ${(peak * 1.4).toFixed(3)})`);
  flare.addColorStop(1, `rgba(${edge}, 0)`);
  ctx.fillStyle = flare;
  ctx.fillRect(0, cy - 1, width, 2);
}

function drawRing(t, plan, cx, cy, reach) {
  const local = (t - plan.flash) / (plan.ring - plan.flash);
  if (local < 0 || local > 1) return;
  const r = reach * (0.05 + ease(local) * 0.4 + local * 0.75);
  const alpha = (1 - local) * (full ? 0.7 : 0.5);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = dark
    ? `rgba(126, 227, 236, ${alpha.toFixed(3)})`
    : `rgba(0, 107, 118, ${alpha.toFixed(3)})`;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.94, 0, Math.PI * 2);
  ctx.strokeStyle = dark
    ? `rgba(63, 214, 226, ${(alpha * 0.35).toFixed(3)})`
    : `rgba(0, 127, 140, ${(alpha * 0.3).toFixed(3)})`;
  ctx.lineWidth = 6;
  ctx.stroke();
}

ace.scene({
  init(view) {
    size(view);
  },
  signal(name) {
    if (startedAt >= 0) return;
    full = name === "pr-merged";
    startedAt = now;
  },
  frame(time, view) {
    now = time;
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (startedAt < 0 || over) return;
    const plan = timing();
    const t = time - startedAt;
    if (t >= plan.end) {
      over = true;
      ace.finish();
      return;
    }
    // The jump point sits ahead of the bow: a little above the window's centre.
    const cx = width * 0.5;
    const cy = height * 0.42;
    const reach = Math.hypot(width, height) * 0.6;
    const fade = t < plan.ring ? 1 : 1 - (t - plan.ring) / (plan.end - plan.ring);
    drawStreaks(t, plan, cx, cy, reach, fade);
    drawFlash(t, plan, cx, cy, reach);
    drawRing(t, plan, cx, cy, reach);
    if (view && (view.width !== width || view.height !== height)) size(view);
  },
  resize(view) {
    size(view);
  },
  scheme(scheme) {
    dark = scheme !== "light";
  },
});
