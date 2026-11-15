// Alpine Lodge's backdrop: the view through the lodge's frosted window.
//
// Evening: a dusk sky from deep blue-violet down to a last ember glow on the horizon, a distant
// mountain with a snow cap, two rows of pines, a few early stars and slow snowfall. Morning: a
// bright, pale winter sky over the same valley, the mountain lit, the pines blue-green, snow
// drifting down. Frost gathers at the window's edges in both.
//
// The far layers (sky, stars, mountain, pines, frost) are painted once per size and scheme onto
// an offscreen canvas and copied in whole once; after that a frame only puts the valley back
// under each flake's last box and draws the flakes again, a few hundred small squares in three
// fills, every other tick. The brightness range stays narrow in each scheme (dark stays dark, light stays
// light), so text over the window reads anywhere. Signals only lift the snow's glint a moment.

let ctx = null;
let doc = null;
let backdrop = null; // the painted far layers
let backdropKey = "";
let now = 0;
let tick = 0;
let glintAt = -1e9;
let flakes = [];

let seed = 3;
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

const palettes = {
  dark: {
    sky: ["#121A32", "#1E2544", "#352A44", "#4C303C"],
    glow: "rgba(224,132,72,0.30)",
    horizon: "rgba(176,92,70,0.34)",
    star: "rgba(240,236,226,0.7)",
    farRidge: "#2A2B46",
    mountain: "#30344F",
    mountainShade: "#262943",
    cap: "rgba(206,212,236,0.26)",
    pinesFar: "#1B1D2C",
    pinesNear: "#0F1019",
    snowGround: "#2C2F46",
    frost: "rgba(200,212,240,0.12)",
    flake: [232, 236, 246],
    flakeAlpha: 0.7,
  },
  light: {
    sky: ["#C9DCEC", "#DCE8F1", "#ECF1F4", "#F6F2EC"],
    glow: "rgba(255,226,180,0.42)",
    horizon: "rgba(255,214,170,0.30)",
    star: "rgba(0,0,0,0)",
    farRidge: "#C4D0DC",
    mountain: "#B3C2D2",
    mountainShade: "#A2B2C4",
    cap: "rgba(255,255,255,0.85)",
    pinesFar: "#94A9B4",
    pinesNear: "#7F949C",
    snowGround: "#EEF2F5",
    frost: "rgba(255,255,255,0.55)",
    flake: [255, 255, 255],
    flakeAlpha: 0.85,
  },
};

function ridge(g, w, h, base, height, roughness, seedValue) {
  seed = seedValue;
  g.beginPath();
  g.moveTo(0, h);
  let y = base;
  for (let x = 0; x <= w + 20; x += 20) {
    y += (random() - 0.5) * roughness;
    y = Math.max(base - height, Math.min(base + height * 0.3, y));
    g.lineTo(x, y);
  }
  g.lineTo(w, h);
  g.closePath();
  g.fill();
}

function pines(g, w, base, size, spacing, seedValue) {
  seed = seedValue;
  for (let x = -spacing; x < w + spacing; x += spacing * (0.55 + random() * 0.7)) {
    const s = size * (0.6 + random() * 0.6);
    const top = base - s;
    g.beginPath();
    // Three stacked tiers, each a little narrower, read as a fir at any size.
    for (let tier = 0; tier < 3; tier++) {
      const ty = top + (s * tier) / 3.4;
      const half = (s * (0.16 + tier * 0.09)) / 1;
      g.moveTo(x, ty);
      g.lineTo(x + half, ty + s * 0.42);
      g.lineTo(x - half, ty + s * 0.42);
      g.closePath();
    }
    g.rect(x - s * 0.025, base - s * 0.12, s * 0.05, s * 0.14);
    g.fill();
  }
}

function paintBackdrop(w, h, scheme) {
  const p = palettes[scheme];
  backdrop = canvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  const g = backdrop.getContext("2d");
  const sky = g.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, p.sky[0]);
  sky.addColorStop(0.45, p.sky[1]);
  sky.addColorStop(0.72, p.sky[2]);
  sky.addColorStop(1, p.sky[3]);
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);

  // The last light (evening) or the low sun (morning), behind the mountain.
  const glow = g.createRadialGradient(
    w * 0.62,
    h * 0.7,
    0,
    w * 0.62,
    h * 0.7,
    Math.max(w, h) * 0.6,
  );
  glow.addColorStop(0, p.glow);
  glow.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = glow;
  g.fillRect(0, 0, w, h);
  const band = g.createLinearGradient(0, h * 0.42, 0, h * 0.72);
  band.addColorStop(0, "rgba(0,0,0,0)");
  band.addColorStop(1, p.horizon);
  g.fillStyle = band;
  g.fillRect(0, h * 0.42, w, h * 0.3);

  if (scheme === "dark") {
    seed = 17;
    g.fillStyle = p.star;
    for (let i = 0; i < 70; i++) {
      const r = 0.4 + random() * 0.8;
      g.beginPath();
      g.arc(random() * w, random() * h * 0.45, r, 0, Math.PI * 2);
      g.fill();
    }
  }

  // A far ridge, then the mountain: one broad peak with a snow cap.
  g.fillStyle = p.farRidge;
  ridge(g, w, h, h * 0.66, h * 0.08, h * 0.035, 5);
  const peakX = w * 0.64;
  const peakY = h * 0.3;
  g.fillStyle = p.mountain;
  g.beginPath();
  g.moveTo(w * 0.18, h * 0.78);
  g.lineTo(w * 0.42, h * 0.48);
  g.lineTo(w * 0.5, h * 0.5);
  g.lineTo(peakX, peakY);
  g.lineTo(w * 0.72, h * 0.4);
  g.lineTo(w * 0.8, h * 0.44);
  g.lineTo(w * 1.08, h * 0.76);
  g.closePath();
  g.fill();
  g.fillStyle = p.mountainShade;
  g.beginPath();
  g.moveTo(peakX, peakY);
  g.lineTo(w * 0.72, h * 0.4);
  g.lineTo(w * 0.8, h * 0.44);
  g.lineTo(w * 1.08, h * 0.76);
  g.lineTo(w * 0.7, h * 0.78);
  g.closePath();
  g.fill();
  g.fillStyle = p.cap;
  g.beginPath();
  g.moveTo(peakX, peakY);
  g.lineTo(w * 0.69, h * 0.38);
  g.lineTo(w * 0.665, h * 0.395);
  g.lineTo(w * 0.645, h * 0.375);
  g.lineTo(w * 0.62, h * 0.4);
  g.lineTo(w * 0.6, h * 0.385);
  g.lineTo(w * 0.585, h * 0.36);
  g.closePath();
  g.fill();

  // Snow on the valley floor, and two rows of pines in front of it.
  g.fillStyle = p.snowGround;
  ridge(g, w, h, h * 0.86, h * 0.02, h * 0.012, 23);
  // Each row stands on a strip of its own colour, so no ground shows between the trunks.
  g.fillStyle = p.pinesFar;
  pines(g, w, h * 0.84, h * 0.11, 22, 41);
  g.fillRect(0, h * 0.79, w, h * 0.07);
  g.fillStyle = p.pinesNear;
  pines(g, w, h * 0.99, h * 0.2, 36, 59);
  g.fillRect(0, h * 0.9, w, h * 0.1);

  // Frost on the pane, gathered at the edges and corners.
  const frost = g.createRadialGradient(
    w / 2,
    h / 2,
    Math.min(w, h) * 0.35,
    w / 2,
    h / 2,
    Math.max(w, h) * 0.75,
  );
  frost.addColorStop(0, "rgba(0,0,0,0)");
  frost.addColorStop(1, p.frost);
  g.fillStyle = frost;
  g.fillRect(0, 0, w, h);
}

// Three depths of snow: far flakes are small, faint and slow; near ones bigger and quicker.
const depths = [
  { size: 1.5, fall: 10, alpha: 0.55 },
  { size: 2.2, fall: 18, alpha: 0.75 },
  { size: 3.2, fall: 30, alpha: 0.95 },
];

function makeFlakes(w, h) {
  seed = 97;
  const count = Math.round(Math.min(260, (w * h) / 4200));
  flakes = depths.map(() => []);
  for (let i = 0; i < count; i++) {
    const layer = random() < 0.5 ? 0 : random() < 0.7 ? 1 : 2;
    flakes[layer].push({
      x: random() * w,
      y: random() * h,
      sway: 6 + random() * 14,
      phase: random() * Math.PI * 2,
    });
  }
}

// Where each flake was last drawn, as whole-pixel boxes [x, y, size] to put the valley back.
let drawn = [];

function draw(v) {
  const w = v.width;
  const h = v.height;
  const key = `${w}x${h}:${v.scheme}`;
  ctx.setTransform(v.pixelRatio, 0, 0, v.pixelRatio, 0, 0);
  if (key !== backdropKey) {
    // The whole valley once, per size and scheme.
    backdropKey = key;
    paintBackdrop(w, h, v.scheme);
    makeFlakes(w, h);
    ctx.drawImage(backdrop, 0, 0, w, h);
    drawn = [];
  } else {
    // Then only the snow moves: each flake's old box gets the valley back under it.
    for (let i = 0; i < drawn.length; i += 3) {
      const x = drawn[i];
      const y = drawn[i + 1];
      const s = drawn[i + 2];
      if (y + s > 0 && y < h) ctx.drawImage(backdrop, x, y, s, s, x, y, s, s);
    }
    drawn.length = 0;
  }
  const p = palettes[v.scheme];
  const t = v.reduceMotion ? 0 : now / 1000;
  const glint = 1 + Math.max(0, 1 - (now - glintAt) / 1600) * 0.6;
  const [r, gc, b] = p.flake;
  // One path per depth, filled once: a few hundred squares cost three fills.
  for (let d = 0; d < depths.length; d++) {
    const depth = depths[d];
    const size = depth.size;
    const box = Math.ceil(size) + 2;
    ctx.fillStyle = `rgba(${r},${gc},${b},${Math.min(1, depth.alpha * p.flakeAlpha * glint).toFixed(3)})`;
    ctx.beginPath();
    const layer = flakes[d];
    for (let i = 0; i < layer.length; i++) {
      const f = layer[i];
      const y = Math.round(((f.y + t * depth.fall) % (h + 10)) - 5);
      const x = Math.round((f.x + Math.sin(t * 0.4 + f.phase) * f.sway + w) % w);
      ctx.rect(x, y, size, size);
      drawn.push(Math.max(0, x - 1), Math.max(0, y - 1), box);
    }
    ctx.fill();
  }
}

ace.scene({
  init(v) {
    doc = v.canvas.ownerDocument || document;
    ctx = v.canvas.getContext("2d");
  },
  frame(time, v) {
    now = time;
    // Snow is slow: every other tick (15 fps at most) is plenty, and halves the cost.
    tick++;
    if (!v.reduceMotion && tick % 2 === 0 && backdropKey !== "") return;
    draw(v);
  },
  signal(name) {
    if (name === "done" || name === "pr-merged") glintAt = now;
  },
  resize(_v) {
    backdropKey = "";
  },
  scheme(_scheme) {
    backdropKey = "";
  },
});
