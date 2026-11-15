// Quest Journal's celebration: plays once over the window for a moment after a quest is done
// or a pull request merges. A soft golden burst opens behind the centre, a crimson banner
// unrolls from a scroll in both directions, its words ink in ("Quest complete", or "Bounty
// claimed" for a merge), gold flecks drift down, and everything fades by 3.6 s. The canvas is
// otherwise clear, so the window shows through. Under Reduce motion it draws nothing.

const flecks = 42;
const fadeStart = 2900;
const fadeEnd = 3600;

let ctx = null;
let width = 0;
let height = 0;
let ratio = 1;
let still = false;
let start = -1;
let words = "Quest complete";

const fleckX = new Float32Array(flecks);
const fleckY = new Float32Array(flecks);
const fleckVX = new Float32Array(flecks);
const fleckVY = new Float32Array(flecks);
const fleckSize = new Float32Array(flecks);
const fleckSpin = new Float32Array(flecks);

let seed = 0x9015;
function random() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
}
for (let i = 0; i < flecks; i++) {
  const angle = random() * Math.PI * 2;
  const speed = 0.08 + random() * 0.22;
  fleckX[i] = 0;
  fleckY[i] = 0;
  fleckVX[i] = Math.cos(angle) * speed;
  fleckVY[i] = Math.sin(angle) * speed - 0.08;
  fleckSize[i] = 1.4 + random() * 2.6;
  fleckSpin[i] = random() * Math.PI * 2;
}

const clamp = (value) => Math.max(0, Math.min(1, value));
const easeOut = (t) => 1 - (1 - t) * (1 - t) * (1 - t);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function size(view) {
  width = view.width;
  height = view.height;
  ratio = view.pixelRatio;
  still = view.reduceMotion;
  ctx = view.canvas.getContext("2d");
}

// The rays and glow behind the banner.
function burst(cx, cy, t, fade) {
  const open = easeOut(clamp(t / 900));
  const radius = Math.min(width, height) * (0.18 + 0.42 * open);
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  const a = 0.38 * fade * (1 - 0.35 * clamp((t - 900) / 1600));
  glow.addColorStop(0, `rgba(255,222,150,${a})`);
  glow.addColorStop(0.4, `rgba(232,180,96,${a * 0.45})`);
  glow.addColorStop(1, "rgba(232,180,96,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);

  // Thin rays that fade along their length, turning slowly.
  const rays = 28;
  const turn = t * 0.00005;
  const reach = radius * 1.25;
  const shine = ctx.createRadialGradient(cx, cy, 0, cx, cy, reach);
  shine.addColorStop(0, `rgba(250,214,140,${0.2 * fade * open})`);
  shine.addColorStop(0.5, `rgba(240,196,120,${0.07 * fade * open})`);
  shine.addColorStop(1, "rgba(240,196,120,0)");
  ctx.fillStyle = shine;
  for (let i = 0; i < rays; i++) {
    const angle = (i / rays) * Math.PI * 2 + turn;
    const spread = i % 2 === 0 ? 0.03 : 0.016;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(angle - spread) * reach, cy + Math.sin(angle - spread) * reach);
    ctx.lineTo(cx + Math.cos(angle + spread) * reach, cy + Math.sin(angle + spread) * reach);
    ctx.closePath();
    ctx.fill();
  }
}

// One rolled end of the scroll: a short cylinder with a gold cap.
function roll(x, cy, h, fade) {
  const w = h * 0.22;
  const body = ctx.createLinearGradient(x - w, 0, x + w, 0);
  body.addColorStop(0, `rgba(74,22,20,${fade})`);
  body.addColorStop(0.5, `rgba(150,52,42,${fade})`);
  body.addColorStop(1, `rgba(60,18,16,${fade})`);
  ctx.fillStyle = body;
  ctx.fillRect(x - w, cy - h * 0.62, w * 2, h * 1.24);
  ctx.fillStyle = `rgba(214,168,96,${fade})`;
  ctx.fillRect(x - w, cy - h * 0.66, w * 2, h * 0.08);
  ctx.fillRect(x - w, cy + h * 0.58, w * 2, h * 0.08);
}

function banner(cx, cy, t, fade) {
  const h = Math.max(44, Math.min(72, width * 0.05));
  const full = Math.min(width * 0.8, h * 9.5);
  const open = easeInOut(clamp((t - 180) / 950));
  const half = (full / 2) * open;
  if (half < 2) {
    roll(cx, cy, h, fade);
    return;
  }

  // The swallowtail ends slide out from behind the rolls once the band is nearly open.
  const tail = h * 0.9 * easeOut(clamp((open - 0.75) / 0.25));
  ctx.fillStyle = `rgba(96,26,24,${fade})`;
  for (const side of tail > 0 ? [-1, 1] : []) {
    const x = cx + side * half;
    ctx.beginPath();
    ctx.moveTo(x, cy - h * 0.25);
    ctx.lineTo(x + side * tail, cy - h * 0.25);
    ctx.lineTo(x + side * tail * 0.7, cy + h * 0.2);
    ctx.lineTo(x + side * tail, cy + h * 0.65);
    ctx.lineTo(x, cy + h * 0.65);
    ctx.closePath();
    ctx.fill();
  }

  // The band, with a fold of shade along its lower edge and gold rules.
  const band = ctx.createLinearGradient(0, cy - h / 2, 0, cy + h / 2);
  band.addColorStop(0, `rgba(150,46,38,${fade})`);
  band.addColorStop(0.55, `rgba(122,34,30,${fade})`);
  band.addColorStop(1, `rgba(84,22,20,${fade})`);
  ctx.fillStyle = band;
  ctx.fillRect(cx - half, cy - h / 2, half * 2, h);
  ctx.fillStyle = `rgba(226,180,110,${0.9 * fade})`;
  ctx.fillRect(cx - half, cy - h / 2 + 4, half * 2, 1.2);
  ctx.fillRect(cx - half, cy + h / 2 - 5.2, half * 2, 1.2);

  // The words, inked in once the band is mostly open, clipped to what has unrolled.
  const ink = clamp((t - 700) / 600);
  if (ink > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx - half, cy - h / 2, half * 2, h);
    ctx.clip();
    ctx.font = `italic 600 ${Math.round(h * 0.52)}px "Iowan Old Style", Palatino, "Palatino Linotype", "Book Antiqua", Georgia, serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = `rgba(40,8,6,${0.5 * ink * fade})`;
    ctx.fillText(words, cx + 1, cy + 2);
    ctx.fillStyle = `rgba(250,226,170,${ink * fade})`;
    ctx.fillText(words, cx, cy + 1);
    ctx.restore();
  }

  roll(cx - half, cy, h, fade);
  roll(cx + half, cy, h, fade);
}

function sparks(cx, cy, t, fade) {
  const s = clamp((t - 250) / 3000);
  if (s <= 0) return;
  const reach = Math.min(width, height) * 0.9;
  for (let i = 0; i < flecks; i++) {
    const x = cx + fleckVX[i] * reach * easeOut(s);
    const y = cy + fleckVY[i] * reach * easeOut(s) + s * s * reach * 0.35;
    const glint = 0.5 + 0.5 * Math.sin(t * 0.008 + fleckSpin[i] * 4);
    ctx.fillStyle = `rgba(246,210,130,${(0.45 + 0.5 * glint) * fade * (1 - s * 0.5)})`;
    const r = fleckSize[i] * (0.6 + 0.4 * glint);
    ctx.beginPath();
    ctx.moveTo(x, y - r * 1.8);
    ctx.lineTo(x + r * 0.5, y);
    ctx.lineTo(x, y + r * 1.8);
    ctx.lineTo(x - r * 0.5, y);
    ctx.closePath();
    ctx.fill();
  }
}

function draw(time) {
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width * ratio, height * ratio);
  if (still) return;
  if (start < 0) start = time;
  const t = time - start;
  if (t >= fadeEnd) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const fade = 1 - easeInOut(clamp((t - fadeStart) / (fadeEnd - fadeStart)));
  const cx = width / 2;
  const cy = height * 0.42;
  burst(cx, cy, t, fade);
  sparks(cx, cy, t, fade);
  banner(cx, cy, t, fade);
}

ace.scene({
  init(view) {
    size(view);
  },
  resize(view) {
    size(view);
  },
  motion(reduceMotion) {
    still = reduceMotion;
  },
  frame(time) {
    draw(time);
  },
  signal(name) {
    words = name === "pr-merged" ? "Bounty claimed" : "Quest complete";
  },
});
