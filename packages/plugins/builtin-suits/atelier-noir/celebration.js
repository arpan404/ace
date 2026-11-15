// Atelier Noir's celebration: a gold wax seal pressed onto the window when the work is done.
// It drops in from above the glass, presses (the wax squashes and spreads), rests while a glint
// crosses its face, then lifts away in light. A merged pull request gets the seal with two satin
// ribbon tails. The whole moment is 3.6 s; afterwards the canvas is clear and ace unmounts it.
// Shapes only (no images), allocated once per size; each frame clears and draws a few dozen paths.

const dropMs = 460;
const pressMs = 260;
const glintFrom = 950;
const glintMs = 900;
const fadeFrom = 2500;
const fadeMs = 1100;
const endMs = fadeFrom + fadeMs;

let ctx = null;
let width = 1;
let height = 1;
let ratio = 1;
let scheme = "dark";
let still = false;
let startAt = null;
let ribbons = false;

const points = 44;
const blobR = new Float32Array(points);

// The seal's monogram: an A whose heavy right leg is also an N's diagonal, as in the header.
// Polygons in a 64-unit box, centred on (32, 31.5).
const monogram = [
  [26.6, 16, 27.5, 16, 18.6, 47, 17.7, 47],
  [25.6, 16, 29.2, 16, 41.5, 47, 37.9, 47],
  [40.6, 16, 41.5, 16, 41.5, 47, 40.6, 47],
  [22.6, 15.5, 28, 15.5, 28, 16.1, 22.6, 16.1],
  [37.4, 15.5, 44.6, 15.5, 44.6, 16.1, 37.4, 16.1],
  [14.4, 46.6, 21.8, 46.6, 21.8, 47.2, 14.4, 47.2],
  [21, 36.4, 34.2, 36.4, 34.2, 37, 21, 37],
];
const monoCx = 29.5;
const monoCy = 31.5;

let seed = 23;
function random() {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
}

function shape() {
  seed = 23;
  // A wax edge: low, uneven lobes, never a perfect circle.
  const a = random() * 6;
  const b = random() * 6;
  for (let i = 0; i < points; i++) {
    const t = (i / points) * Math.PI * 2;
    blobR[i] =
      1 + 0.045 * Math.sin(t * 3 + a) + 0.03 * Math.sin(t * 7 + b) + (random() - 0.5) * 0.035;
  }
}

function size(view) {
  width = view.width;
  height = view.height;
  ratio = Math.min(2, view.pixelRatio || 1);
  scheme = view.scheme === "light" ? "light" : "dark";
  if (typeof view.reduceMotion === "boolean") still = view.reduceMotion;
  view.canvas.width = Math.max(1, Math.round(width * ratio));
  view.canvas.height = Math.max(1, Math.round(height * ratio));
  ctx = view.canvas.getContext("2d");
}

const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (p) => 1 - (1 - p) * (1 - p) * (1 - p);
const easeIn = (p) => p * p;

function blobPath(cx, cy, r, spread) {
  ctx.beginPath();
  for (let i = 0; i <= points; i++) {
    const k = i % points;
    const t = (k / points) * Math.PI * 2;
    const rr = r * (1 + (blobR[k] - 1) * spread);
    const x = cx + Math.cos(t) * rr;
    const y = cy + Math.sin(t) * rr;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function monogramPath(cx, cy, scale) {
  ctx.beginPath();
  for (const poly of monogram) {
    for (let i = 0; i < poly.length; i += 2) {
      const x = cx + (poly[i] - monoCx) * scale;
      const y = cy + (poly[i + 1] - monoCy) * scale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }
}

function ribbon(cx, cy, r, side) {
  const dark = scheme === "dark";
  const x0 = cx + side * r * 0.25;
  const y0 = cy + r * 0.3;
  const x1 = cx + side * r * 0.95;
  const y1 = cy + r * 1.75;
  const w = r * 0.34;
  ctx.beginPath();
  ctx.moveTo(x0 - w * 0.5, y0);
  ctx.lineTo(x0 + w * 0.5, y0);
  ctx.lineTo(x1 + w * 0.5, y1);
  ctx.lineTo(x1, y1 - w * 0.45);
  ctx.lineTo(x1 - w * 0.5, y1);
  ctx.closePath();
  const g = ctx.createLinearGradient(x0 - w, y0, x0 + w, y0);
  g.addColorStop(0, dark ? "#0b0a08" : "#2a231a");
  g.addColorStop(0.5, dark ? "#2b2620" : "#4a3f30");
  g.addColorStop(1, dark ? "#0b0a08" : "#2a231a");
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = "rgba(199, 167, 108, 0.55)";
  ctx.lineWidth = 0.75;
  ctx.stroke();
}

function seal(cx, cy, r, spread, glint) {
  // The cast shadow first: a soft pool under the wax.
  const shadow = ctx.createRadialGradient(cx, cy + r * 0.12, r * 0.6, cx, cy + r * 0.12, r * 1.35);
  shadow.addColorStop(0, scheme === "dark" ? "rgba(0,0,0,0.55)" : "rgba(60,40,10,0.28)");
  shadow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = shadow;
  ctx.fillRect(cx - r * 1.5, cy - r * 1.4, r * 3, r * 3);

  // The wax: warm gold, lit from the upper left.
  blobPath(cx, cy, r, spread);
  const wax = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.05, cx, cy, r * 1.08);
  wax.addColorStop(0, "#f1dcaa");
  wax.addColorStop(0.35, "#cfa863");
  wax.addColorStop(0.75, "#9a7236");
  wax.addColorStop(1, "#5f441c");
  ctx.fillStyle = wax;
  ctx.fill();

  // The pressed field: a recessed disc with a lit lower rim and a shaded upper one.
  const inner = r * 0.74;
  ctx.beginPath();
  ctx.arc(cx, cy, inner, 0, Math.PI * 2);
  const field = ctx.createRadialGradient(cx + r * 0.2, cy + r * 0.25, r * 0.1, cx, cy, inner);
  field.addColorStop(0, "#c9a05b");
  field.addColorStop(1, "#8f6930");
  ctx.fillStyle = field;
  ctx.fill();
  ctx.lineWidth = Math.max(1, r * 0.025);
  ctx.strokeStyle = "rgba(70, 48, 16, 0.75)";
  ctx.beginPath();
  ctx.arc(cx, cy, inner, Math.PI * 1.05, Math.PI * 1.95);
  ctx.stroke();
  ctx.strokeStyle = "rgba(255, 238, 196, 0.6)";
  ctx.beginPath();
  ctx.arc(cx, cy, inner, Math.PI * 0.05, Math.PI * 0.95);
  ctx.stroke();

  // A beaded border inside the rim.
  const beads = 32;
  for (let i = 0; i < beads; i++) {
    const t = (i / beads) * Math.PI * 2;
    const bx = cx + Math.cos(t) * inner * 0.88;
    const by = cy + Math.sin(t) * inner * 0.88;
    ctx.beginPath();
    ctx.arc(bx, by, r * 0.022, 0, Math.PI * 2);
    ctx.fillStyle = Math.sin(t) > 0 ? "rgba(255, 238, 196, 0.55)" : "rgba(70, 48, 16, 0.55)";
    ctx.fill();
  }

  // The monogram, embossed: a shadow below-right, a highlight above-left, then the face.
  const scale = (inner * 1.12) / 31;
  const o = Math.max(0.8, r * 0.012);
  monogramPath(cx + o, cy + o, scale);
  ctx.fillStyle = "rgba(60, 40, 12, 0.7)";
  ctx.fill();
  monogramPath(cx - o * 0.8, cy - o * 0.8, scale);
  ctx.fillStyle = "rgba(255, 240, 205, 0.65)";
  ctx.fill();
  monogramPath(cx, cy, scale);
  ctx.fillStyle = "#b58a47";
  ctx.fill();

  // A glint crossing the face, clipped to the wax.
  if (glint > 0 && glint < 1) {
    ctx.save();
    blobPath(cx, cy, r, spread);
    ctx.clip();
    const gx = cx - r * 1.4 + glint * r * 2.8;
    const g = ctx.createLinearGradient(gx - r * 0.3, cy - r, gx + r * 0.3, cy + r);
    const peak = (Math.sin(glint * Math.PI) * 0.5).toFixed(3);
    g.addColorStop(0, "rgba(255, 248, 225, 0)");
    g.addColorStop(0.5, `rgba(255, 248, 225, ${peak})`);
    g.addColorStop(1, "rgba(255, 248, 225, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(cx - r * 1.2, cy - r * 1.2, r * 2.4, r * 2.4);
    ctx.restore();
  }
}

function draw(time) {
  if (!ctx) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const r = Math.max(64, Math.min(116, Math.min(width, height) * 0.12));
  const cx = width / 2;
  const cy = height * 0.46;
  if (still) {
    // Reduce motion: the seal at rest, no veil, no movement.
    if (ribbons) {
      ribbon(cx, cy, r, -1);
      ribbon(cx, cy, r, 1);
    }
    seal(cx, cy, r, 1, 0);
    return;
  }
  if (startAt === null) startAt = time;
  const t = time - startAt;
  if (t >= endMs) return;
  const fade = 1 - easeIn(clamp((t - fadeFrom) / fadeMs));
  // A veil dims the room a little so the seal reads, and lifts with it.
  const veil = clamp(t / dropMs) * fade * (scheme === "dark" ? 0.32 : 0.14);
  ctx.fillStyle =
    scheme === "dark" ? `rgba(4, 3, 2, ${veil.toFixed(3)})` : `rgba(40, 30, 14, ${veil.toFixed(3)})`;
  ctx.fillRect(0, 0, width, height);

  const drop = easeIn(clamp(t / dropMs));
  const press = clamp((t - dropMs) / pressMs);
  // Falls from 1.5x (nearer the eye) to the glass, squashes 6% and settles.
  const squash = press > 0 && press < 1 ? Math.sin(press * Math.PI) * 0.06 : 0;
  const scale = (1.5 - 0.5 * drop) * (1 - squash);
  const spread = 0.4 + 0.6 * easeOut(press);
  const rise = (1 - fade) * r * 0.25;
  ctx.globalAlpha = clamp(t / (dropMs * 0.6)) * fade;
  if (ribbons && t > dropMs) {
    ctx.save();
    ctx.globalAlpha *= easeOut(clamp((t - dropMs) / 400));
    ribbon(cx, cy - rise, r, -1);
    ribbon(cx, cy - rise, r, 1);
    ctx.restore();
  }
  const glint = clamp((t - glintFrom) / glintMs);
  seal(cx, cy - rise, r * scale, spread, glint);
  ctx.globalAlpha = 1;
}

ace.scene({
  init(view) {
    shape();
    size(view);
  },
  resize(view) {
    size(view);
  },
  scheme(next) {
    scheme = next === "light" ? "light" : "dark";
  },
  motion(reduceMotion) {
    still = reduceMotion;
  },
  frame(time, view) {
    if (typeof view.reduceMotion === "boolean") still = view.reduceMotion;
    draw(time);
  },
  signal(name) {
    // The moment starts on the next frame; a merged pull request adds the ribbons.
    ribbons = name === "pr-merged";
    if (name === "done" || name === "pr-merged") startAt = null;
  },
});
