// Glasshouse's backdrop: the light inside a conservatory, seen through its panes.
//
// Day: a pale mint field warmed by the sun at the top left, two layers of water-like caustics
// drifting very slowly across it, a few soft sun shafts, and the blurred shadows of fronds
// swaying at the edges. Night: the same room under moonlight from the top right, cool and dim.
// Everything is drawn from sprites built in init and on resize or scheme change, so a frame is a
// gradient fill and a few dozen blits. The brightness range stays narrow in each scheme, so text
// on the panes reads the same everywhere. Signals only brighten the light for a moment.

let ctx = null;
let doc = null;
let width = 1;
let height = 1;
let ratio = 1;
let scheme = "light";
let now = 0;
let liftAt = -1e9;
let lift = 0;

let base = null; // the field's gradient
let glow = null; // a soft white disc, 256 px
let tile = null; // seamless caustic tile
let pattern = null;
let shaft = null; // a soft light beam
let fronds = []; // blurred frond shadows

const tileSize = 384;

// Fixed placements, as fractions of the window, so the room is the same every time.
const leafSpots = [
  { x: -0.02, y: -0.04, s: 1.15, r: 0.55, sway: 0.9, kind: 0 },
  { x: 0.16, y: -0.1, s: 0.8, r: 1.25, sway: 1.3, kind: 1 },
  { x: 0.98, y: 0.02, s: 1.05, r: 2.5, sway: 1.1, kind: 0 },
  { x: 0.84, y: -0.08, s: 0.75, r: 1.9, sway: 1.6, kind: 1 },
  { x: 1.02, y: 0.78, s: 1.2, r: 3.6, sway: 0.8, kind: 0 },
  { x: -0.04, y: 0.86, s: 1.1, r: -0.6, sway: 1.0, kind: 1 },
];
const shafts = [
  { x: 0.12, w: 0.16, a: 0.9 },
  { x: 0.34, w: 0.1, a: 0.6 },
  { x: 0.55, w: 0.2, a: 0.5 },
];

let seed = 7;
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

function buildGlow() {
  glow = canvas(256, 256);
  const g = glow.getContext("2d");
  const fill = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  fill.addColorStop(0, "rgba(255,255,255,1)");
  fill.addColorStop(0.35, "rgba(255,255,255,0.45)");
  fill.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = fill;
  g.fillRect(0, 0, 256, 256);
}

function buildShaft() {
  shaft = canvas(64, 512);
  const g = shaft.getContext("2d");
  const across = g.createLinearGradient(0, 0, 64, 0);
  across.addColorStop(0, "rgba(255,255,255,0)");
  across.addColorStop(0.5, "rgba(255,255,255,1)");
  across.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = across;
  g.fillRect(0, 0, 64, 512);
  g.globalCompositeOperation = "destination-in";
  const along = g.createLinearGradient(0, 0, 0, 512);
  along.addColorStop(0, "rgba(0,0,0,1)");
  along.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = along;
  g.fillRect(0, 0, 64, 512);
}

// A ring of light with an uneven edge, drawn at each wrap offset so the tile repeats seamlessly.
function ring(g, cx, cy, r, wobble) {
  for (let ox = -tileSize; ox <= tileSize; ox += tileSize)
    for (let oy = -tileSize; oy <= tileSize; oy += tileSize) {
      g.beginPath();
      for (let i = 0; i <= 12; i++) {
        const t = (i / 12) * Math.PI * 2;
        const rr = r * (1 + wobble[i % 12]);
        const x = cx + ox + Math.cos(t) * rr;
        const y = cy + oy + Math.sin(t) * rr * 0.8;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.closePath();
      g.stroke();
    }
}

function buildTile() {
  seed = 11;
  const sharp = canvas(tileSize, tileSize);
  const g = sharp.getContext("2d");
  g.lineJoin = "round";
  const tint = scheme === "dark" ? "rgba(190,236,232,0.85)" : "rgba(255,255,250,0.95)";
  g.strokeStyle = tint;
  const wobble = new Float32Array(12);
  for (let n = 0; n < 34; n++) {
    for (let i = 0; i < 12; i++) wobble[i] = (random() - 0.5) * 0.28;
    g.lineWidth = 0.8 + random() * 1.8;
    ring(g, random() * tileSize, random() * tileSize, 26 + random() * 46, wobble);
  }
  tile = canvas(tileSize, tileSize);
  const t = tile.getContext("2d");
  t.filter = "blur(5px)";
  t.drawImage(sharp, 0, 0);
  t.filter = "blur(1.2px)";
  t.drawImage(sharp, 0, 0);
  t.filter = "none";
  pattern = ctx.createPattern(tile, "repeat");
}

// A frond: a curved stem with leaflets that shorten toward its tip, then blurred into a shadow.
function buildFrond(kind) {
  seed = 31 + kind * 13;
  const size = 360;
  const sharp = canvas(size, size);
  const g = sharp.getContext("2d");
  g.fillStyle = "#000";
  g.strokeStyle = "#000";
  g.lineCap = "round";
  const pairs = kind === 0 ? 9 : 6;
  const bend = kind === 0 ? 0.25 : -0.35;
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(20, size - 20);
  g.quadraticCurveTo(size * 0.45, size * (0.55 + bend * 0.3), size - 30, 30);
  g.stroke();
  for (let i = 1; i <= pairs; i++) {
    const p = i / (pairs + 1);
    const q = 1 - p;
    const x = q * q * 20 + 2 * q * p * size * 0.45 + p * p * (size - 30);
    const y = q * q * (size - 20) + 2 * q * p * size * (0.55 + bend * 0.3) + p * p * 30;
    const len = (kind === 0 ? 92 : 120) * (1 - p * 0.6) * (0.85 + random() * 0.3);
    const wide = kind === 0 ? 0.22 : 0.34;
    for (const side of [-1, 1]) {
      const angle = -Math.PI / 4 + side * (Math.PI / 2.6) + (random() - 0.5) * 0.2;
      g.save();
      g.translate(x, y);
      g.rotate(angle);
      g.beginPath();
      g.moveTo(0, 0);
      g.quadraticCurveTo(len * 0.5, -len * wide, len, 0);
      g.quadraticCurveTo(len * 0.5, len * wide, 0, 0);
      g.fill();
      g.restore();
    }
  }
  const soft = canvas(size, size);
  const s = soft.getContext("2d");
  s.filter = "blur(7px)";
  s.drawImage(sharp, 0, 0);
  s.filter = "none";
  return soft;
}

function buildBase() {
  base = ctx.createLinearGradient(0, 0, width, height);
  if (scheme === "dark") {
    base.addColorStop(0, "#0C171C");
    base.addColorStop(0.55, "#0F1D23");
    base.addColorStop(1, "#122329");
  } else {
    base.addColorStop(0, "#E6EEE6");
    base.addColorStop(0.5, "#D8E5E2");
    base.addColorStop(1, "#CCDCDB");
  }
}

function build(view) {
  width = view.width;
  height = view.height;
  ratio = view.pixelRatio || 1;
  scheme = view.scheme === "dark" ? "dark" : "light";
  ctx = view.canvas.getContext("2d");
  if (!glow) {
    buildGlow();
    buildShaft();
    fronds = [buildFrond(0), buildFrond(1)];
  }
  buildTile();
  buildBase();
}

function draw(time, still) {
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, width, height);

  const dark = scheme === "dark";
  const t = still ? 0 : time / 1000;
  const breathe = still ? 0 : Math.sin(t * 0.12) * 0.04;
  const bright = lift * Math.max(0, 1 - (time - liftAt) / 1800);
  const span = Math.max(width, height);

  // The sun (or moon), large and soft, in its corner.
  const sx = dark ? width * 0.9 : width * 0.08;
  const sy = -span * 0.08;
  const sr = span * (dark ? 0.55 : 0.75);
  ctx.globalAlpha = (dark ? 0.1 : 0.5) + breathe + bright * 0.15;
  ctx.drawImage(glow, sx - sr, sy - sr, sr * 2, sr * 2);

  // Light shafts falling from that corner.
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(dark ? 0.5 : -0.5);
  for (const beam of shafts) {
    const drift = still ? 0 : Math.sin(t * 0.05 + beam.x * 9) * span * 0.01;
    ctx.globalAlpha = beam.a * (dark ? 0.035 : 0.22);
    const off = (dark ? -1 : 1) * beam.x * span;
    ctx.drawImage(shaft, off + drift, 0, beam.w * span, span * 1.3);
  }
  ctx.restore();

  // Caustics: the same tile twice, at two scales, drifting against each other.
  if (pattern) {
    ctx.globalAlpha = (dark ? 0.06 : 0.32) + bright * 0.1;
    ctx.fillStyle = pattern;
    ctx.setTransform(
      ratio * 1.4,
      0,
      0,
      ratio * 1.4,
      ratio * ((t * 3) % (tileSize * 1.4)),
      ratio * ((t * 1.6) % (tileSize * 1.4)),
    );
    ctx.fillRect(-tileSize, -tileSize, width / 1.4 + tileSize * 2, height / 1.4 + tileSize * 2);
    ctx.globalAlpha = (dark ? 0.045 : 0.22) + bright * 0.08;
    ctx.setTransform(
      ratio * 2.1,
      0,
      0,
      ratio * 2.1,
      -ratio * ((t * 2.2) % (tileSize * 2.1)),
      ratio * ((t * 1.1) % (tileSize * 2.1)),
    );
    ctx.fillRect(-tileSize, -tileSize, width / 2.1 + tileSize * 2, height / 2.1 + tileSize * 2);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  // Frond shadows at the edges, swaying a few degrees.
  ctx.globalAlpha = dark ? 0.22 : 0.09;
  for (const spot of leafSpots) {
    const frond = fronds[spot.kind];
    const size = span * 0.36 * spot.s;
    const sway = still ? 0 : Math.sin(t * 0.35 * spot.sway + spot.r * 3) * 0.035;
    ctx.save();
    ctx.translate(spot.x * width, spot.y * height);
    ctx.rotate(spot.r + sway);
    ctx.drawImage(frond, 0, 0, size, size);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

ace.scene({
  init(view) {
    doc = view.canvas.ownerDocument || (typeof document === "undefined" ? null : document);
    build(view);
  },
  resize(view) {
    build(view);
  },
  scheme(_next) {},
  frame(time, view) {
    now = time;
    if (view.scheme !== scheme || view.width !== width || view.height !== height) build(view);
    draw(time, view.reduceMotion);
  },
  signal(name) {
    lift = name === "done" || name === "pr-merged" ? 1 : name === "working" ? 0.35 : 0;
    liftAt = now;
  },
});
