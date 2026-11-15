// Glasshouse's celebration: when work is done, a sweep of sunlight crosses every pane.
//
// A soft diagonal band of light travels from left to right across the window, split at its edges
// into thin prism fringes (aqua ahead, then gold, rose trailing), the way light breaks at a
// glass edge. Where it passes, small glints catch and fade. A merged pull request gets a
// brighter, wider sweep and a second, fainter echo. About 3 s in all, then the canvas is clear
// and ace takes the layer down. Shapes and gradients only, built once per size.

const sweepMs = 2300;
const fadeFrom = 2500;
const endMs = 3100;

let ctx = null;
let doc = null;
let width = 1;
let height = 1;
let ratio = 1;
let scheme = "light";
let startAt = -1;
let pending = false;
let merged = false;
let finished = false;

let core = null;
let fringes = [];
let glint = null;
const glints = [];

let seed = 5;
function random() {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
}

function canvas(w, h) {
  const c = doc.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function strip(color, peak) {
  const c = canvas(128, 4);
  const g = c.getContext("2d");
  const fill = g.createLinearGradient(0, 0, 128, 0);
  fill.addColorStop(0, `rgba(${color},0)`);
  fill.addColorStop(0.5, `rgba(${color},${peak})`);
  fill.addColorStop(1, `rgba(${color},0)`);
  g.fillStyle = fill;
  g.fillRect(0, 0, 128, 4);
  return c;
}

function build(view) {
  width = view.width;
  height = view.height;
  ratio = view.pixelRatio || 1;
  scheme = view.scheme === "dark" ? "dark" : "light";
  ctx = view.canvas.getContext("2d");
  if (!core) {
    core = strip("255,255,255", 1);
    fringes = [
      { sprite: strip("120,235,225", 1), at: 0.62, width: 0.05 },
      { sprite: strip("255,224,150", 1), at: 0.5, width: 0.045 },
      { sprite: strip("255,184,214", 1), at: -0.58, width: 0.05 },
    ];
    glint = canvas(64, 64);
    const g = glint.getContext("2d");
    const halo = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    halo.addColorStop(0, "rgba(255,255,255,1)");
    halo.addColorStop(0.18, "rgba(255,255,255,0.55)");
    halo.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = halo;
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = "rgba(255,255,255,0.9)";
    g.beginPath();
    g.moveTo(32, 2);
    g.lineTo(34, 30);
    g.lineTo(62, 32);
    g.lineTo(34, 34);
    g.lineTo(32, 62);
    g.lineTo(30, 34);
    g.lineTo(2, 32);
    g.lineTo(30, 30);
    g.closePath();
    g.fill();
  }
  seed = 5;
  glints.length = 0;
  for (let i = 0; i < 26; i++)
    glints.push({ x: random(), y: random(), s: 10 + random() * 16, d: random() * 0.2 });
}

const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// One sweep: its band centre crosses the window's diagonal extent as progress goes 0 → 1.
function sweep(progress, strength, bandScale) {
  const span = Math.hypot(width, height);
  const band = span * 0.16 * bandScale;
  const angle = 0.38;
  const reach = width + height * Math.tan(angle) + band * 2;
  const x = -band + ease(progress) * reach - height * Math.tan(angle) * 0.5;
  ctx.save();
  ctx.translate(x, height / 2);
  ctx.rotate(angle);
  const tall = span * 1.4;
  ctx.globalCompositeOperation = scheme === "dark" ? "lighter" : "source-over";
  ctx.globalAlpha = strength * (scheme === "dark" ? 0.2 : 0.34);
  ctx.drawImage(core, -band / 2, -tall / 2, band, tall);
  for (const fringe of fringes) {
    ctx.globalAlpha = strength * (scheme === "dark" ? 0.22 : 0.3);
    const w = span * fringe.width * bandScale;
    ctx.drawImage(fringe.sprite, fringe.at * band - w / 2, -tall / 2, w, tall);
  }
  ctx.restore();
  return { x, angle };
}

function draw(time) {
  const t = time - startAt;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (t >= endMs) {
    finished = true;
    // Hosts older than the celebration contract have no finish(); they take the layer down on time.
    if (typeof ace.finish === "function") ace.finish();
    return;
  }
  const fade = t > fadeFrom ? 1 - clamp((t - fadeFrom) / (endMs - fadeFrom)) : 1;
  const intro = clamp(t / 260);
  const strength = fade * intro * (merged ? 1.15 : 1);
  const progress = clamp(t / sweepMs);
  const front = sweep(progress, strength, merged ? 1.25 : 1);
  if (merged && t > 420) sweep(clamp((t - 420) / sweepMs), strength * 0.45, 0.7);

  // Glints catch where the band has just passed: the band's line is x' = x + (y - h/2) * tan.
  ctx.globalCompositeOperation = scheme === "dark" ? "lighter" : "source-over";
  for (const g of glints) {
    const px = g.x * width;
    const py = g.y * height;
    const lineX = front.x + (py - height / 2) * -Math.tan(front.angle);
    const behind = lineX - px;
    if (behind < 0) continue;
    const age = behind / (width * 0.35) - g.d;
    if (age < 0 || age > 1) continue;
    const life = Math.sin(age * Math.PI);
    ctx.globalAlpha = life * fade * (scheme === "dark" ? 0.55 : 0.85);
    const s = g.s * (0.6 + life * 0.6);
    ctx.drawImage(glint, px - s, py - s, s * 2, s * 2);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}

ace.scene({
  init(view) {
    doc = view.canvas.ownerDocument || (typeof document === "undefined" ? null : document);
    build(view);
  },
  resize(view) {
    build(view);
  },
  signal(name) {
    if (startAt >= 0 || pending) return;
    merged = name === "pr-merged";
    // The clock is shared, so the sweep starts from the next frame's time, whatever it reads.
    pending = true;
  },
  frame(time, view) {
    if (pending) {
      pending = false;
      startAt = time;
    }
    if (view.width !== width || view.height !== height || view.scheme !== scheme) build(view);
    if (startAt < 0 || finished) {
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);
      return;
    }
    draw(time);
  },
});
