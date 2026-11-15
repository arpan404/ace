// Quest Journal: the desk the journal lies on. A sheet of parchment fills the window; by night a
// candle burns below the page's lower right and its light breathes very slightly, by day a soft
// beam falls from the upper right. Dust motes drift slowly through the light. The paper's
// fibres, its mottling and the vignette are painted once per size into a layer and copied each
// frame, so a frame is one copy, two gradients and a few dozen dots.
// Signals are small: working lifts the flame, waiting makes it gutter, failed dips it for a
// breath, done and a merged pull request swell the glow and loosen a few gold motes.

const maxMotes = 70;

const looks = {
  dark: {
    paper: "#1d1611",
    edge: "rgba(6,4,2,0.55)",
    fibre: [236, 214, 170],
    fibreAlpha: 0.035,
    blotch: [70, 46, 26],
    light: [255, 176, 96],
    lightAlpha: 0.11,
    mote: [255, 214, 150],
    moteAlpha: 0.5,
  },
  light: {
    paper: "#f5ebd4",
    edge: "rgba(150,108,52,0.1)",
    fibre: [140, 104, 60],
    fibreAlpha: 0.045,
    blotch: [214, 176, 112],
    light: [255, 252, 238],
    lightAlpha: 0.55,
    mote: [150, 112, 60],
    moteAlpha: 0.32,
  },
};

let ctx = null;
let layer = null;
let layerCtx = null;
let width = 0;
let height = 0;
let ratio = 1;
let scheme = "dark";
let still = false;
let now = 0;

let liftUntil = -Infinity;
let gutterAt = -Infinity;
let dipAt = -Infinity;
let swellAt = -Infinity;

const moteX = new Float32Array(maxMotes);
const moteY = new Float32Array(maxMotes);
const moteSize = new Float32Array(maxMotes);
const moteSpeed = new Float32Array(maxMotes);
const motePhase = new Float32Array(maxMotes);
const moteGold = new Uint8Array(maxMotes);

// A small seeded generator, so the paper and the motes are the same on every load.
let seed = 0x5eed;
function random() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
}

function seedMotes() {
  seed = 0x0d057;
  for (let i = 0; i < maxMotes; i++) {
    moteX[i] = random();
    moteY[i] = random();
    moteSize[i] = 0.5 + random() * 1.3;
    moteSpeed[i] = 0.4 + random() * 0.8;
    motePhase[i] = random() * Math.PI * 2;
    moteGold[i] = 0;
  }
}

// The light's centre, in the window's px: a candle low on the right of the page by night, the
// beam's source high on the right by day (the sidebar covers the window's left).
function lightCentre() {
  return scheme === "dark" ? [width * 0.74, height * 1.02] : [width * 0.88, height * -0.04];
}

function paintLayer() {
  if (!layer) layer = document.createElement("canvas");
  layer.width = Math.max(1, Math.round(width * ratio));
  layer.height = Math.max(1, Math.round(height * ratio));
  layerCtx = layer.getContext("2d");
  const look = looks[scheme];
  const g = layerCtx;
  g.setTransform(ratio, 0, 0, ratio, 0, 0);
  g.fillStyle = look.paper;
  g.fillRect(0, 0, width, height);

  // Mottling: broad, faint stains where the parchment has aged unevenly.
  seed = 0x9a7c4;
  const [br, bg, bb] = look.blotch;
  for (let i = 0; i < 18; i++) {
    const x = random() * width;
    const y = random() * height;
    const r = 80 + random() * 260;
    const a = (scheme === "dark" ? 0.1 : 0.08) * (0.4 + random() * 0.6);
    const stain = g.createRadialGradient(x, y, 0, x, y, r);
    stain.addColorStop(0, `rgba(${br},${bg},${bb},${a})`);
    stain.addColorStop(1, `rgba(${br},${bg},${bb},0)`);
    g.fillStyle = stain;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Fibres: short, mostly horizontal strokes, as laid paper shows against the light.
  const [fr, fg, fb] = look.fibre;
  const fibres = Math.min(2600, Math.round((width * height) / 420));
  g.lineWidth = 0.6;
  for (let i = 0; i < fibres; i++) {
    const x = random() * width;
    const y = random() * height;
    const length = 3 + random() * 14;
    const angle = (random() - 0.5) * 0.7;
    g.strokeStyle = `rgba(${fr},${fg},${fb},${look.fibreAlpha * (0.4 + random())})`;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length);
    g.stroke();
  }

  // Chain lines, very faint, every 26 px: the mould's wires pressed into the sheet.
  g.strokeStyle = `rgba(${fr},${fg},${fb},${look.fibreAlpha * 0.6})`;
  g.lineWidth = 1;
  for (let x = 13; x < width; x += 26) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, height);
    g.stroke();
  }

  // The vignette: the sheet darkens toward its edges, as a page does away from the light.
  const vignette = g.createRadialGradient(
    width * 0.5,
    height * 0.5,
    Math.min(width, height) * 0.35,
    width * 0.5,
    height * 0.5,
    Math.max(width, height) * 0.78,
  );
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, look.edge);
  g.fillStyle = vignette;
  g.fillRect(0, 0, width, height);
}

function size(view) {
  width = view.width;
  height = view.height;
  ratio = view.pixelRatio;
  scheme = view.scheme;
  still = view.reduceMotion;
  ctx = view.canvas.getContext("2d");
  paintLayer();
}

// The flame's breath: a slow swell with a little flutter on top, 0..1.
function flicker(time) {
  if (still) return 0.5;
  const slow = Math.sin(time * 0.0011) * 0.5 + Math.sin(time * 0.0017 + 1.3) * 0.3;
  const flutter = Math.sin(time * 0.0093 + Math.sin(time * 0.0031) * 2) * 0.2;
  return 0.5 + (slow + flutter) * 0.5;
}

function since(at) {
  return now - at;
}

function draw(time) {
  if (!ctx || !layer) return;
  const look = looks[scheme];
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(layer, 0, 0);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

  // How bright the light is now.
  let strength = 0.8 + flicker(time) * 0.2;
  if (now < liftUntil) strength += 0.12;
  const gutter = since(gutterAt);
  if (gutter >= 0 && gutter < 1800) strength -= 0.18 * Math.sin((gutter / 1800) * Math.PI);
  const dip = since(dipAt);
  if (dip >= 0 && dip < 1400) strength -= 0.35 * (1 - dip / 1400);
  const swell = since(swellAt);
  if (swell >= 0 && swell < 2600) strength += 0.3 * Math.sin((swell / 2600) * Math.PI);

  const [cx, cy] = lightCentre();
  const [lr, lg, lb] = look.light;
  const reach = Math.max(width, height) * (scheme === "dark" ? 0.72 : 0.95);
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, reach);
  const alpha = look.lightAlpha * strength;
  glow.addColorStop(0, `rgba(${lr},${lg},${lb},${alpha})`);
  glow.addColorStop(0.45, `rgba(${lr},${lg},${lb},${alpha * 0.38})`);
  glow.addColorStop(1, `rgba(${lr},${lg},${lb},0)`);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  // Dust motes: they rise slowly (by night, in the candle's warm air) or sink (by day, in the
  // beam) and sway; each shows only as bright as the light where it floats.
  const [mr, mg, mb] = look.mote;
  const drift = still ? 0 : time * 0.000006;
  const rising = scheme === "dark" ? -1 : 1;
  for (let i = 0; i < maxMotes; i++) {
    let y = (moteY[i] + rising * drift * moteSpeed[i]) % 1;
    if (y < 0) y += 1;
    const sway = still ? 0 : Math.sin(time * 0.0004 * moteSpeed[i] + motePhase[i]) * 0.012;
    const x = (moteX[i] + sway + 1) % 1;
    const px = x * width;
    const py = y * height;
    const dx = (px - cx) / reach;
    const dy = (py - cy) / reach;
    const lit = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) * 1.15);
    if (lit <= 0.02) continue;
    const twinkle = still ? 0.8 : 0.65 + 0.35 * Math.sin(time * 0.002 + motePhase[i] * 3);
    let a = look.moteAlpha * lit * twinkle * Math.min(1.2, strength);
    let colour = `${mr},${mg},${mb}`;
    if (moteGold[i] && swell >= 0 && swell < 2600) {
      a = Math.min(0.8, a + 0.35 * Math.sin((swell / 2600) * Math.PI));
      colour = "236,190,110";
    }
    ctx.fillStyle = `rgba(${colour},${a})`;
    ctx.beginPath();
    ctx.arc(px, py, moteSize[i], 0, Math.PI * 2);
    ctx.fill();
  }
}

seedMotes();

ace.scene({
  init(view) {
    size(view);
  },
  resize(view) {
    size(view);
  },
  scheme(next) {
    scheme = next;
    paintLayer();
  },
  motion(reduceMotion) {
    still = reduceMotion;
  },
  frame(time, view) {
    now = time;
    still = view ? view.reduceMotion : still;
    draw(time);
  },
  signal(name) {
    if (name === "working") liftUntil = now + 3000;
    else if (name === "waiting") gutterAt = now;
    else if (name === "failed") dipAt = now;
    else if (name === "done" || name === "pr-merged") {
      swellAt = now;
      for (let i = 0; i < maxMotes; i++) moteGold[i] = i % 3 === 0 ? 1 : 0;
    }
  },
});
