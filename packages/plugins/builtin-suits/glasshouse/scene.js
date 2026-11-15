// Glasshouse's backdrop: the light inside a conservatory, seen through its panes.
//
// Day: a warm cream-to-mint room with blooms of coloured light (sun gold, honey, leaf green,
// aqua) drifting very slowly, out-of-focus foliage silhouettes leaning in from the edges, specks
// of sunlight through the leaves and a slow caustic over everything. Night: the same room under
// moonlight, blue and teal blooms on deep green-black, the foliage nearly black.
//
// The light is composed in a field a third of the window's size (it is all soft light, so the
// stretch only softens it further) from sprites built once, the caustic tile once per scheme;
// a frame is a small gradient fill, a few dozen small blits and one full-size copy. The
// brightness range stays narrow in each scheme so text on the panes reads everywhere. Signals
// only brighten the light for a moment.

const fieldScale = 1 / 3;
const tileSize = 384;

let out = null; // the scene's own canvas
let field = null; // the small canvas the light is composed in
let ctx = null; // its context
let doc = null;
let width = 1; // the field's size
let height = 1;
let viewWidth = 0;
let viewHeight = 0;
let scheme = "";
let now = 0;
let liftAt = -1e9;
let lift = 0;

let base = null;
let pattern = null;
let speck = null; // a soft white disc
let blooms = []; // coloured glow sprites, per scheme
let leaves = []; // blurred foliage silhouettes

// Fixed placements, as fractions of the window, so the room is the same every time.
const bloomSpots = {
  light: [
    { rgb: "255,192,96", a: 0.58, x: 0.3, y: -0.06, r: 0.66, d: 0.9 },
    { rgb: "255,220,140", a: 0.38, x: 0.66, y: 0.06, r: 0.4, d: 1.3 },
    { rgb: "100,190,205", a: 0.44, x: 0.08, y: 0.98, r: 0.56, d: 0.8 },
    { rgb: "120,190,110", a: 0.48, x: 0.74, y: 0.92, r: 0.56, d: 1.1 },
    { rgb: "165,215,150", a: 0.36, x: 0.86, y: 0.32, r: 0.36, d: 1.6 },
    { rgb: "120,200,190", a: 0.32, x: 0.4, y: 0.55, r: 0.3, d: 1.2 },
  ],
  dark: [
    { rgb: "110,150,235", a: 0.32, x: 0.88, y: 0.04, r: 0.6, d: 0.9 },
    { rgb: "40,150,150", a: 0.34, x: 0.12, y: 0.86, r: 0.55, d: 1.1 },
    { rgb: "60,90,170", a: 0.24, x: 0.48, y: 0.45, r: 0.45, d: 1.4 },
    { rgb: "80,190,200", a: 0.16, x: 0.78, y: 0.8, r: 0.38, d: 0.8 },
  ],
};
const leafSpots = [
  { x: -0.06, y: -0.1, s: 1.25, r: 0.7, sway: 0.9, kind: 0 },
  { x: 0.22, y: -0.16, s: 0.85, r: 1.5, sway: 1.3, kind: 1 },
  { x: 1.04, y: -0.04, s: 1.1, r: 2.3, sway: 1.1, kind: 0 },
  { x: 1.08, y: 0.62, s: 1.3, r: 3.3, sway: 0.8, kind: 1 },
  { x: -0.08, y: 0.7, s: 1.15, r: -0.3, sway: 1.0, kind: 0 },
  { x: 0.46, y: 1.08, s: 0.95, r: -1.6, sway: 1.2, kind: 1 },
];
const specks = [];

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

function glowSprite(rgb, size) {
  const c = canvas(size, size);
  const g = c.getContext("2d");
  const half = size / 2;
  const fill = g.createRadialGradient(half, half, 0, half, half, half);
  fill.addColorStop(0, `rgba(${rgb},1)`);
  fill.addColorStop(0.4, `rgba(${rgb},0.5)`);
  fill.addColorStop(0.75, `rgba(${rgb},0.14)`);
  fill.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = fill;
  g.fillRect(0, 0, size, size);
  return c;
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
  g.strokeStyle = scheme === "dark" ? "rgba(170,230,235,0.9)" : "rgba(255,252,236,0.95)";
  const wobble = new Float32Array(12);
  for (let n = 0; n < 34; n++) {
    for (let i = 0; i < 12; i++) wobble[i] = (random() - 0.5) * 0.28;
    g.lineWidth = 1 + random() * 2.2;
    ring(g, random() * tileSize, random() * tileSize, 26 + random() * 46, wobble);
  }
  const tile = canvas(tileSize, tileSize);
  const t = tile.getContext("2d");
  t.filter = "blur(6px)";
  t.drawImage(sharp, 0, 0);
  t.filter = "blur(1.5px)";
  t.drawImage(sharp, 0, 0);
  t.filter = "none";
  pattern = ctx.createPattern(tile, "repeat");
}

// Foliage, drawn sharp then blurred into an out-of-focus silhouette. Kind 0 is a broad leaf with
// split lobes on a stem; kind 1 a frond of narrow leaflets.
function buildLeaf(kind) {
  seed = 31 + kind * 13;
  const size = 300;
  const sharp = canvas(size, size);
  const g = sharp.getContext("2d");
  g.fillStyle = "#000";
  g.strokeStyle = "#000";
  g.lineCap = "round";
  if (kind === 0) {
    g.lineWidth = 7;
    g.beginPath();
    g.moveTo(20, size - 10);
    g.quadraticCurveTo(70, size * 0.7, 120, size * 0.55);
    g.stroke();
    g.save();
    g.translate(170, 120);
    g.rotate(-0.55);
    g.beginPath();
    g.ellipse(0, 0, 118, 92, 0, 0, Math.PI * 2);
    g.fill();
    // Splits in the leaf, cut from its edge toward the midrib.
    g.globalCompositeOperation = "destination-out";
    g.lineWidth = 9;
    for (let i = 0; i < 7; i++) {
      const a = -Math.PI * 0.8 + i * 0.36;
      g.beginPath();
      g.moveTo(Math.cos(a) * 130, Math.sin(a) * 104);
      g.lineTo(Math.cos(a) * 46, Math.sin(a) * 36);
      g.stroke();
    }
    g.restore();
    g.globalCompositeOperation = "source-over";
  } else {
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(16, size - 16);
    g.quadraticCurveTo(size * 0.42, size * 0.62, size - 24, 24);
    g.stroke();
    const pairs = 8;
    for (let i = 1; i <= pairs; i++) {
      const p = i / (pairs + 1);
      const q = 1 - p;
      const x = q * q * 16 + 2 * q * p * size * 0.42 + p * p * (size - 24);
      const y = q * q * (size - 16) + 2 * q * p * size * 0.62 + p * p * 24;
      const len = 96 * (1 - p * 0.55) * (0.85 + random() * 0.3);
      for (const side of [-1, 1]) {
        g.save();
        g.translate(x, y);
        g.rotate(-Math.PI / 4 + side * (Math.PI / 2.5) + (random() - 0.5) * 0.2);
        g.beginPath();
        g.moveTo(0, 0);
        g.quadraticCurveTo(len * 0.5, -len * 0.26, len, 0);
        g.quadraticCurveTo(len * 0.5, len * 0.26, 0, 0);
        g.fill();
        g.restore();
      }
    }
  }
  const soft = canvas(size, size);
  const s = soft.getContext("2d");
  s.filter = "blur(12px)";
  s.drawImage(sharp, 0, 0);
  s.filter = "none";
  return soft;
}

function buildBase() {
  base = ctx.createLinearGradient(0, 0, width, height);
  if (scheme === "dark") {
    base.addColorStop(0, "#08131A");
    base.addColorStop(0.5, "#0B1A21");
    base.addColorStop(1, "#0E1F26");
  } else {
    base.addColorStop(0, "#F0E4C4");
    base.addColorStop(0.5, "#D8E8D4");
    base.addColorStop(1, "#C4DFDC");
  }
}

function build(view) {
  out = view.canvas.getContext("2d");
  if (!field) {
    field = canvas(1, 1);
    ctx = field.getContext("2d");
    speck = glowSprite("255,255,255", 64);
    leaves = [buildLeaf(0), buildLeaf(1)];
    seed = 19;
    for (let i = 0; i < 16; i++)
      specks.push({ x: random(), y: random(), r: 0.006 + random() * 0.018, v: 0.4 + random() });
  }
  if (view.width !== viewWidth || view.height !== viewHeight) {
    viewWidth = view.width;
    viewHeight = view.height;
    width = Math.max(1, Math.ceil(viewWidth * fieldScale));
    height = Math.max(1, Math.ceil(viewHeight * fieldScale));
    field.width = width;
    field.height = height;
  }
  const next = view.scheme === "dark" ? "dark" : "light";
  // The blurred caustic tile and the tinted blooms only change with the scheme.
  if (next !== scheme || !pattern) {
    scheme = next;
    buildTile();
    blooms = bloomSpots[scheme].map((spot) => glowSprite(spot.rgb, 128));
  }
  buildBase();
}

function draw(time, view) {
  const still = view.reduceMotion;
  const dark = scheme === "dark";
  const t = still ? 0 : time / 1000;
  const bright = lift * Math.max(0, 1 - (time - liftAt) / 1800);
  const span = Math.max(width, height);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, width, height);

  // Blooms of coloured light, each drifting on its own slow loop.
  const spots = bloomSpots[scheme];
  for (let i = 0; i < spots.length; i++) {
    const spot = spots[i];
    const x = (spot.x + Math.sin(t * 0.03 * spot.d + i * 1.7) * 0.04) * width;
    const y = (spot.y + Math.cos(t * 0.025 * spot.d + i) * 0.03) * height;
    const r = spot.r * span * (1 + Math.sin(t * 0.05 + i) * 0.04);
    ctx.globalAlpha = Math.min(1, spot.a + bright * 0.12);
    ctx.drawImage(blooms[i], x - r, y - r, r * 2, r * 2);
  }

  // Caustics: the same tile twice, at two scales, drifting against each other.
  if (pattern) {
    const near = 1.4 * fieldScale;
    const far = 2.2 * fieldScale;
    ctx.globalAlpha = (dark ? 0.055 : 0.3) + bright * 0.1;
    ctx.fillStyle = pattern;
    ctx.setTransform(
      near,
      0,
      0,
      near,
      (t * 3 * fieldScale) % (tileSize * near),
      (t * 1.6 * fieldScale) % (tileSize * near),
    );
    ctx.fillRect(-tileSize, -tileSize, width / near + tileSize * 2, height / near + tileSize * 2);
    ctx.globalAlpha = (dark ? 0.035 : 0.18) + bright * 0.08;
    ctx.setTransform(
      far,
      0,
      0,
      far,
      -((t * 2.2 * fieldScale) % (tileSize * far)),
      (t * 1.1 * fieldScale) % (tileSize * far),
    );
    ctx.fillRect(-tileSize, -tileSize, width / far + tileSize * 2, height / far + tileSize * 2);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // Specks of sun (or moon) through the leaves, rising very slowly.
  ctx.globalAlpha = dark ? 0.14 : 0.42;
  for (const s of specks) {
    const x = s.x * width + Math.sin(t * 0.1 * s.v + s.y * 9) * span * 0.01;
    const y = ((((s.y - t * 0.004 * s.v) % 1) + 1) % 1) * height;
    const r = s.r * span;
    ctx.drawImage(speck, x - r, y - r, r * 2, r * 2);
  }

  // Out-of-focus foliage leaning in from the edges, swaying a few degrees.
  ctx.globalAlpha = dark ? 0.6 : 0.16;
  for (const spot of leafSpots) {
    const leaf = leaves[spot.kind];
    const size = span * 0.42 * spot.s;
    const sway = still ? 0 : Math.sin(t * 0.3 * spot.sway + spot.r * 3) * 0.04;
    ctx.save();
    ctx.translate(spot.x * width, spot.y * height);
    ctx.rotate(spot.r + sway);
    ctx.drawImage(leaf, 0, 0, size, size);
    ctx.restore();
  }
  ctx.globalAlpha = 1;

  // One stretch of the small field onto the canvas, in device pixels.
  out.setTransform(1, 0, 0, 1, 0, 0);
  out.globalAlpha = 1;
  out.imageSmoothingEnabled = true;
  out.drawImage(field, 0, 0, view.canvas.width, view.canvas.height);
}

ace.scene({
  init(view) {
    doc = view.canvas.ownerDocument || (typeof document === "undefined" ? null : document);
    build(view);
  },
  resize(view) {
    build(view);
  },
  frame(time, view) {
    now = time;
    if (view.scheme !== scheme || view.width !== viewWidth || view.height !== viewHeight)
      build(view);
    draw(time, view);
  },
  signal(name) {
    lift = name === "done" || name === "pr-merged" ? 1 : name === "working" ? 0.35 : 0;
    liftAt = now;
  },
});
