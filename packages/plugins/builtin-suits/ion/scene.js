/*
 * Ion's backdrop: an original neon megacity at night, seen from a wet rooftop.
 * Far and mid towers with lit windows, vertical neon signs, a giant holo-billboard of a face in
 * profile, flying traffic, rain. On the parapet at the right stand two figures: a runner in a
 * long coat with a cyan visor and a chrome arm, and a netrunner sitting on the ledge, jacked into
 * a deck, with a small drone keeping watch. The heavy layers are painted once per size and scheme
 * into offscreen canvases; each frame only blits them and draws rain, cars, flicker and glows.
 * The light scheme is the same city in a pale morning haze.
 */

const looks = {
  dark: {
    sky: ["#05060b", "#0a0b16", "#151026", "#2a1236"],
    haze: [255, 46, 150],
    hazeAlpha: 0.34,
    far: "#0d0f1c",
    farWin: ["rgba(120,170,255,0.4)", "rgba(255,120,200,0.32)", "rgba(255,210,140,0.3)"],
    mid: "#080a12",
    midEdge: "rgba(31,224,236,0.18)",
    win: [
      "rgba(255,214,150,0.8)",
      "rgba(140,220,255,0.75)",
      "rgba(255,110,190,0.7)",
      "rgba(220,230,255,0.55)",
    ],
    fog: "rgba(70,30,90,0.30)",
    neon: ["#ff2e96", "#1fe0ec", "#f5d061", "#b06bff", "#ff6a3d"],
    neonAlpha: 1,
    roof: "#04050a",
    roofEdge: "rgba(31,224,236,0.6)",
    body: "#05060b",
    rimA: "rgba(255,46,150,1)",
    rimB: "rgba(31,224,236,0.95)",
    visor: "#1fe0ec",
    deck: "#ff2e96",
    rain: "rgba(150,200,240,0.16)",
    car: "#0c0e16",
    tail: "#ff3d6e",
    head: "rgba(210,245,255,0.9)",
    holo: "#1fe0ec",
    holoAlpha: 0.95,
  },
  light: {
    sky: ["#c9d5ee", "#d9e1f2", "#ebe3f1", "#f7e2ee"],
    haze: [255, 130, 195],
    hazeAlpha: 0.32,
    far: "#bcc7dc",
    farWin: ["rgba(255,255,255,0.75)", "rgba(220,245,255,0.7)", "rgba(255,225,240,0.65)"],
    mid: "#a7b4cb",
    midEdge: "rgba(0,140,170,0.35)",
    win: [
      "rgba(255,255,255,0.85)",
      "rgba(210,248,255,0.85)",
      "rgba(255,220,238,0.8)",
      "rgba(245,250,255,0.7)",
    ],
    fog: "rgba(245,236,248,0.45)",
    neon: ["#e03f93", "#0096aa", "#c9900e", "#7c4fd0", "#dd5a2c"],
    neonAlpha: 0.85,
    roof: "#8e9bb0",
    roofEdge: "rgba(0,126,168,0.5)",
    body: "#4f5b6d",
    rimA: "rgba(224,63,147,0.75)",
    rimB: "rgba(0,150,170,0.75)",
    visor: "#00a7b8",
    deck: "#e03f93",
    rain: "rgba(80,100,140,0.18)",
    car: "#7d889b",
    tail: "#e0466e",
    head: "rgba(255,255,255,0.95)",
    holo: "#0096aa",
    holoAlpha: 0.75,
  },
};

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(w, h, pr) {
  let c;
  if (typeof OffscreenCanvas !== "undefined")
    c = new OffscreenCanvas(Math.max(1, Math.ceil(w * pr)), Math.max(1, Math.ceil(h * pr)));
  else {
    c = document.createElement("canvas");
    c.width = Math.max(1, Math.ceil(w * pr));
    c.height = Math.max(1, Math.ceil(h * pr));
  }
  const g = c.getContext("2d");
  g.setTransform(pr, 0, 0, pr, 0, 0);
  return { c, g };
}

/** A soft round glow painted once, then stretched with drawImage: no per-frame blur. */
function glowSprite(color) {
  const { c, g } = makeCanvas(64, 64, 1);
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, color);
  grad.addColorStop(0.35, color.replace(/[\d.]+\)$/, "0.35)"));
  grad.addColorStop(1, color.replace(/[\d.]+\)$/, "0)"));
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return c;
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

let ctx, L, W, H, PR, SCHEME;
let back, holo, front; // offscreen layers
let signs = [],
  cars = [],
  drops = [],
  glows = {};
let now = 0,
  surge = 0,
  surgeAt = -Infinity,
  glitchAt = -Infinity;
let figure = {};

const SIGN_WORDS = [
  "\u96fb\u8133",
  "ION",
  "24H",
  "\u30db\u30c6\u30eb",
  "NOODLE",
  "\u591c\u5e02",
  "SYNTH",
  "\u85ac",
];

function build(view) {
  W = view.width;
  H = view.height;
  PR = view.pixelRatio;
  SCHEME = view.scheme;
  L = looks[view.scheme === "light" ? "light" : "dark"];
  const rnd = seeded(2077 ^ 0x9e37);

  /* ── Back: sky, haze, far towers, mid towers with windows, fog ───────────────────────── */
  const B = makeCanvas(W, H, PR);
  back = B.c;
  const g = B.g;
  const sky = g.createLinearGradient(0, 0, 0, H);
  L.sky.forEach((c, i) => sky.addColorStop(i / (L.sky.length - 1), c));
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);
  const hz = g.createRadialGradient(
    W * 0.68,
    H * 0.78,
    0,
    W * 0.68,
    H * 0.78,
    Math.max(W, H) * 0.7,
  );
  hz.addColorStop(0, `rgba(${L.haze.join(",")},${L.hazeAlpha})`);
  hz.addColorStop(1, `rgba(${L.haze.join(",")},0)`);
  g.fillStyle = hz;
  g.fillRect(0, 0, W, H);

  // Far skyline.
  let x = -10;
  while (x < W + 10) {
    const w = 18 + rnd() * 46;
    const top = H * (0.38 + rnd() * 0.22);
    g.fillStyle = L.far;
    g.fillRect(x, top, w, H - top);
    if (rnd() < 0.25) g.fillRect(x + w / 2 - 1, top - 14 - rnd() * 30, 2, 40);
    for (let wy = top + 6; wy < H; wy += 7)
      for (let wx = x + 3; wx < x + w - 3; wx += 5)
        if (rnd() < 0.12) {
          g.fillStyle = L.farWin[(rnd() * L.farWin.length) | 0];
          g.fillRect(wx, wy, 2, 2);
        }
    x += w + rnd() * 4;
  }
  // Fog band between layers.
  const fog = g.createLinearGradient(0, H * 0.45, 0, H);
  fog.addColorStop(0, "rgba(0,0,0,0)");
  fog.addColorStop(0.5, L.fog);
  fog.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = fog;
  g.fillRect(0, H * 0.45, W, H * 0.55);

  // Mid towers: taller, darker, with window grids and lit edges.
  signs = [];
  x = -20;
  let k = 0;
  const towers = [];
  while (x < W + 20) {
    const w = 50 + rnd() * 90;
    const top = H * (0.22 + rnd() * 0.3);
    towers.push({ x, w, top });
    g.fillStyle = L.mid;
    g.fillRect(x, top, w, H - top);
    // stepped crown
    if (rnd() < 0.5) g.fillRect(x + w * 0.2, top - 12, w * 0.6, 12);
    if (rnd() < 0.4) g.fillRect(x + w * 0.45, top - 50 - rnd() * 40, 2, 60);
    g.fillStyle = L.midEdge;
    g.fillRect(x, top, 1, H - top);
    g.fillRect(x, top, w, 1);
    const cols = Math.floor((w - 8) / 7);
    for (let wy = top + 10; wy < H; wy += 9) {
      const rowLit = rnd() < 0.55;
      for (let c = 0; c < cols; c++)
        if (rowLit && rnd() < 0.35) {
          g.fillStyle = L.win[(rnd() * L.win.length) | 0];
          g.fillRect(x + 5 + c * 7, wy, 3, 4);
        }
    }
    // A vertical neon sign on some towers.
    if (rnd() < 0.55 && w > 60) {
      const word = SIGN_WORDS[k++ % SIGN_WORDS.length];
      const sh = Math.min(H * 0.28, 22 * word.length + 16);
      signs.push({
        x: x + (rnd() < 0.5 ? 6 : w - 26),
        y: top + 20 + rnd() * H * 0.12,
        h: sh,
        word,
        color: L.neon[(rnd() * L.neon.length) | 0],
        flick: rnd(),
        rate: 0.3 + rnd() * 1.2,
      });
    }
    x += w + 6 + rnd() * 26;
  }

  /* ── Holo-billboard: an original face in profile, scanlined ──────────────────────────── */
  const hw = Math.max(110, Math.min(220, W * 0.13));
  const hh = hw * 1.5;
  const Hc = makeCanvas(hw, hh, PR);
  holo = { c: Hc.c, w: hw, h: hh, x: W * 0.62, y: H * 0.18 };
  const hg = Hc.g;
  hg.strokeStyle = hexA(L.holo, 0.6);
  hg.lineWidth = 1;
  hg.strokeRect(0.5, 0.5, hw - 1, hh - 1);
  const bgG = hg.createLinearGradient(0, 0, 0, hh);
  bgG.addColorStop(0, hexA(L.holo, 0.1));
  bgG.addColorStop(1, hexA(L.holo, 0.02));
  hg.fillStyle = bgG;
  hg.fillRect(1, 1, hw - 2, hh - 2);
  // Profile facing left: forehead, brow, nose, lips, chin, neck; then back of head with hair.
  const P = (px, py) => [px * hw, py * hh];
  const pts = [
    [0.62, 0.08],
    [0.48, 0.12],
    [0.4, 0.2],
    [0.37, 0.3],
    [0.35, 0.36],
    [0.27, 0.45],
    [0.33, 0.48],
    [0.34, 0.52],
    [0.3, 0.55],
    [0.33, 0.58],
    [0.31, 0.62],
    [0.35, 0.67],
    [0.43, 0.7],
    [0.5, 0.71],
    [0.52, 0.8],
    [0.5, 0.98],
    [0.86, 0.98],
    [0.78, 0.82],
    [0.8, 0.62],
    [0.9, 0.45],
    [0.88, 0.25],
    [0.78, 0.12],
  ];
  hg.beginPath();
  pts.forEach((p, i) => (i ? hg.lineTo(...P(...p)) : hg.moveTo(...P(...p))));
  hg.closePath();
  const face = hg.createLinearGradient(0, 0, hw, 0);
  face.addColorStop(0, hexA(L.holo, 0.55));
  face.addColorStop(1, hexA(L.holo, 0.15));
  hg.fillStyle = face;
  hg.fill();
  hg.strokeStyle = hexA(L.holo, 0.95);
  hg.lineWidth = 1.2;
  hg.stroke();
  // Hair sweep and an eye line.
  hg.beginPath();
  hg.moveTo(...P(0.5, 0.1));
  hg.quadraticCurveTo(...P(0.95, 0.05), ...P(0.96, 0.45));
  hg.quadraticCurveTo(...P(0.92, 0.7), ...P(0.98, 0.9));
  hg.strokeStyle = hexA(L.holo, 0.7);
  hg.stroke();
  hg.fillStyle = hexA(L.neon[0], 0.9);
  hg.fillRect(...P(0.39, 0.33), hw * 0.07, 1.5);
  // Scanlines.
  hg.fillStyle = "rgba(0,0,0,0.22)";
  for (let sy = 0; sy < hh; sy += 3) hg.fillRect(0, sy, hw, 1);
  // Caption bar.
  hg.fillStyle = hexA(L.neon[0], 0.8);
  hg.fillRect(8, hh - 14, hw * 0.35, 4);
  hg.fillStyle = hexA(L.holo, 0.6);
  hg.fillRect(8 + hw * 0.4, hh - 14, hw * 0.2, 4);

  /* ── Front: wet rooftop parapet and the two figures ──────────────────────────────────── */
  const F = makeCanvas(W, H, PR);
  front = F.c;
  const f = F.g;
  const roofY = H * 0.9;
  const roofX = W * 0.56;
  f.fillStyle = L.roof;
  f.beginPath();
  f.moveTo(roofX - 30, H);
  f.lineTo(roofX, roofY);
  f.lineTo(W, roofY);
  f.lineTo(W, H);
  f.closePath();
  f.fill();
  f.fillStyle = L.roofEdge;
  f.fillRect(roofX, roofY, W - roofX, 1);
  // Vent box and antenna mast.
  f.fillStyle = L.roof;
  f.fillRect(W * 0.66, roofY - H * 0.04, W * 0.05, H * 0.04);
  f.fillRect(W * 0.6, roofY - H * 0.22, 2, H * 0.22);
  f.fillRect(W * 0.6 - 10, roofY - H * 0.2, 22, 1.5);
  f.fillRect(W * 0.6 - 6, roofY - H * 0.16, 14, 1.5);
  // Puddle reflection on the roof.
  const pud = f.createLinearGradient(roofX, 0, W, 0);
  pud.addColorStop(0, hexA(L.neon[0], 0));
  pud.addColorStop(0.5, hexA(L.neon[0], 0.12));
  pud.addColorStop(1, hexA(L.neon[1], 0.1));
  f.fillStyle = pud;
  f.fillRect(roofX + 20, roofY + 8, W - roofX - 20, 3);

  const s = Math.max(120, Math.min(300, H * 0.3)); // figure height
  figure = { s, roofY, runX: W * 0.86, sitX: W * 0.74 };
  drawRunner(f, figure.runX, roofY, s);
  drawNetrunner(f, figure.sitX, roofY, s);

  /* ── Moving things ───────────────────────────────────────────────────────────────────── */
  cars = Array.from({ length: 12 }, () => {
    const depth = 0.3 + rnd() * 0.7;
    return {
      y: H * (0.2 + rnd() * 0.45),
      depth,
      speed: (0.012 + rnd() * 0.03) * depth * (rnd() < 0.5 ? -1 : 1),
      off: rnd() * (W + 200),
      size: 6 + depth * 12,
    };
  });
  drops = Array.from({ length: Math.min(260, Math.round((W * H) / 6000)) }, () => ({
    x: rnd(),
    y: rnd(),
    len: 8 + rnd() * 16,
    v: 0.6 + rnd() * 0.6,
  }));
  glows = {
    visor: glowSprite(hexA(L.visor, 0.9)),
    deck: glowSprite(hexA(L.deck, 0.9)),
    tail: glowSprite(hexA(L.tail, 0.9)),
    head: glowSprite(L.head),
    neon: Object.fromEntries(L.neon.map((c) => [c, glowSprite(hexA(c, 0.9))])),
  };
}

/** A rim-lit silhouette: magenta from the city on the left, cyan from the holo on the right. */
function rimFill(g, path) {
  g.save();
  g.translate(-2, 0);
  g.fillStyle = L.rimA;
  g.fill(path);
  g.restore();
  g.save();
  g.translate(2, 0);
  g.fillStyle = L.rimB;
  g.fill(path);
  g.restore();
  g.fillStyle = L.body;
  g.fill(path);
}

/** Build a path from [x, y] pairs in figure units: "q" entries are quadratic curves. */
function shape(p, x, y, s, pts) {
  pts.forEach((pt, i) => {
    if (pt[0] === "q")
      p.quadraticCurveTo(x + pt[1] * s, y + pt[2] * s, x + pt[3] * s, y + pt[4] * s);
    else if (i === 0) p.moveTo(x + pt[0] * s, y + pt[1] * s);
    else p.lineTo(x + pt[0] * s, y + pt[1] * s);
  });
  p.closePath();
}

/* The runner: undercut hair, high collar, long coat lifting in the wind, a chrome right arm. */
function drawRunner(g, x, y, s) {
  const p = new Path2D();
  // Legs and boots.
  shape(p, x, y, s, [
    [-0.085, -0.26],
    [-0.035, -0.26],
    [-0.03, -0.03],
    [-0.02, 0],
    [-0.12, 0],
    [-0.1, -0.03],
  ]);
  shape(p, x, y, s, [
    [0.02, -0.26],
    [0.07, -0.26],
    [0.075, -0.03],
    [0.1, 0],
    [0.02, 0],
    [0.025, -0.03],
  ]);
  // Coat: shoulders, flared hem, the right tail lifted by wind.
  shape(p, x, y, s, [
    [-0.06, -0.835],
    ["q", -0.14, -0.83, -0.155, -0.77],
    [-0.165, -0.55],
    ["q", -0.18, -0.36, -0.205, -0.2],
    [-0.12, -0.215],
    [-0.04, -0.24],
    [0.06, -0.25],
    ["q", 0.18, -0.24, 0.3, -0.17],
    ["q", 0.22, -0.3, 0.175, -0.5],
    [0.16, -0.77],
    ["q", 0.145, -0.83, 0.06, -0.835],
  ]);
  // High collar.
  shape(p, x, y, s, [
    [-0.07, -0.82],
    [-0.06, -0.88],
    [0.06, -0.885],
    [0.075, -0.82],
  ]);
  // Head with an undercut and a swept spike of hair.
  p.moveTo(x + 0.055 * s, y - 0.925 * s);
  p.ellipse(x, y - 0.925 * s, 0.052 * s, 0.062 * s, 0, 0, Math.PI * 2);
  shape(p, x, y, s, [
    [-0.06, -0.95],
    ["q", -0.06, -1.02, 0.02, -1.0],
    [0.11, -1.03],
    ["q", 0.07, -0.98, 0.06, -0.94],
  ]);
  // Left arm, slightly bent, hand at the hip.
  shape(p, x, y, s, [
    [-0.15, -0.79],
    ["q", -0.2, -0.65, -0.205, -0.52],
    [-0.2, -0.45],
    [-0.17, -0.44],
    [-0.165, -0.52],
    ["q", -0.16, -0.64, -0.12, -0.76],
  ]);
  rimFill(g, p);

  // Chrome right arm: plates, glowing joints and a lit forearm seam.
  const arm = new Path2D();
  shape(arm, x, y, s, [
    [0.135, -0.78],
    [0.185, -0.77],
    [0.2, -0.6],
    [0.205, -0.46],
    [0.175, -0.44],
    [0.165, -0.6],
  ]);
  g.fillStyle = L.body;
  // oxlint-disable-next-line unicorn/no-array-fill-with-reference-type -- a canvas fill, not Array#fill
  g.fill(arm);
  g.strokeStyle = hexA(L.visor, 0.55);
  g.lineWidth = 1;
  g.stroke(arm);
  g.fillStyle = hexA(L.visor, 0.9);
  g.fillRect(x + 0.165 * s, y - 0.605 * s, 0.035 * s, 1.5);
  g.fillRect(x + 0.17 * s, y - 0.53 * s, 0.033 * s, 1);
  g.fillRect(x + 0.188 * s, y - 0.59 * s, 1, 0.13 * s);
  // Coat details: a lapel seam and the belt, in faint neon.
  g.strokeStyle = hexA(L.neon[0], 0.35);
  g.beginPath();
  g.moveTo(x - 0.02 * s, y - 0.83 * s);
  g.lineTo(x + 0.01 * s, y - 0.56 * s);
  g.lineTo(x + 0.04 * s, y - 0.25 * s);
  g.stroke();
  g.fillStyle = hexA(L.neon[0], 0.3);
  g.fillRect(x - 0.15 * s, y - 0.5 * s, 0.31 * s, 1.5);
}

/* The netrunner: hood up, headset, hunched over a glowing deck on the parapet's edge. */
function drawNetrunner(g, x, y, s) {
  const p = new Path2D();
  // Hooded torso, hunched forward.
  shape(p, x, y, s, [
    [0.07, 0],
    ["q", 0.09, -0.18, 0.04, -0.3],
    ["q", 0.01, -0.42, -0.07, -0.45],
    ["q", -0.14, -0.45, -0.16, -0.38],
    [-0.165, -0.33],
    [-0.14, -0.3],
    [-0.12, -0.26],
    [-0.1, 0],
  ]);
  // Arms reaching to the deck on the knees.
  shape(p, x, y, s, [
    [-0.03, -0.3],
    ["q", -0.13, -0.24, -0.2, -0.14],
    [-0.22, -0.11],
    [-0.19, -0.1],
    ["q", -0.12, -0.18, -0.02, -0.22],
  ]);
  // Thighs forward, shins hanging over the edge, boots.
  shape(p, x, y, s, [
    [0.02, -0.08],
    [-0.21, -0.1],
    ["q", -0.25, -0.08, -0.24, -0.04],
    [-0.24, 0.16],
    [-0.27, 0.19],
    [-0.18, 0.19],
    [-0.19, -0.01],
    [0.04, 0],
  ]);
  rimFill(g, p);
  // Headset band and ear glow, and the cable from the jack to the deck.
  g.strokeStyle = hexA(L.deck, 0.9);
  g.lineWidth = 1.4;
  g.beginPath();
  g.arc(x - 0.07 * s, y - 0.37 * s, 0.065 * s, Math.PI * 1.05, Math.PI * 1.75);
  g.stroke();
  g.fillStyle = hexA(L.deck, 0.9);
  g.fillRect(x - 0.06 * s, y - 0.36 * s, 0.02 * s, 0.03 * s);
  g.strokeStyle = hexA(L.visor, 0.6);
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(x - 0.05 * s, y - 0.33 * s);
  g.bezierCurveTo(x + 0.08 * s, y - 0.2 * s, x - 0.02 * s, y - 0.02 * s, x - 0.18 * s, y - 0.1 * s);
  g.stroke();
  // The deck: a slim slab with a lit screen tilted toward the face.
  g.fillStyle = L.body;
  g.fillRect(x - 0.27 * s, y - 0.115 * s, 0.11 * s, 0.018 * s);
  g.fillStyle = hexA(L.deck, 0.95);
  g.beginPath();
  g.moveTo(x - 0.265 * s, y - 0.12 * s);
  g.lineTo(x - 0.25 * s, y - 0.19 * s);
  g.lineTo(x - 0.19 * s, y - 0.19 * s);
  g.lineTo(x - 0.2 * s, y - 0.12 * s);
  g.closePath();
  g.fill();
}

function drawSign(g, sg, alpha) {
  const glow = glows.neon[sg.color];
  g.globalAlpha = alpha * 0.35;
  g.drawImage(glow, sg.x - 18, sg.y - 18, 56, sg.h + 36);
  g.globalAlpha = alpha;
  g.strokeStyle = sg.color;
  g.lineWidth = 1.2;
  g.strokeRect(sg.x, sg.y, 20, sg.h);
  g.fillStyle = sg.color;
  g.font = "600 13px system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  const chars = [...sg.word];
  const step = (sg.h - 12) / chars.length;
  chars.forEach((ch, i) => g.fillText(ch, sg.x + 10, sg.y + 8 + step * (i + 0.5)));
  g.globalAlpha = 1;
}

function draw(t, still) {
  ctx.setTransform(PR, 0, 0, PR, 0, 0);
  ctx.drawImage(back, 0, 0, W, H);
  const boost = 1 + 0.6 * Math.max(0, 1 - (t - surgeAt) / 1800) * surge;

  // Neon signs: steady, with a rare flicker per sign.
  for (const sg of signs) {
    const ph = (t * 0.001 * sg.rate + sg.flick * 10) % 10;
    const flick = still ? 1 : ph < 0.12 ? 0.25 : ph < 0.2 ? 0.9 : ph < 0.26 ? 0.3 : 1;
    drawSign(ctx, sg, Math.min(1, L.neonAlpha * flick * boost));
  }

  // Holo-billboard with a slow breath and a rare horizontal glitch.
  const h = holo;
  const breathe = still ? 1 : 0.85 + 0.15 * Math.sin(t * 0.0011);
  ctx.globalAlpha = Math.min(1, L.holoAlpha * breathe * boost);
  ctx.drawImage(glows.visor, h.x - h.w * 0.3, h.y - h.h * 0.15, h.w * 1.6, h.h * 1.3);
  ctx.globalAlpha = Math.min(1, L.holoAlpha * breathe * boost);
  ctx.drawImage(h.c, h.x, h.y, h.w, h.h);
  const gl = t - glitchAt;
  if (!still && (gl < 160 || t % 7300 < 120)) {
    const band = h.h * (0.3 + 0.4 * ((t * 0.37) % 1));
    const sw = h.c.width / h.w;
    ctx.drawImage(h.c, 0, band * sw, h.c.width, 8 * sw, h.x + 6, h.y + band, h.w, 8);
  }
  ctx.globalAlpha = 1;

  // Flying traffic.
  for (const c of cars) {
    const span = W + 200;
    let cx = (c.off + (still ? 0 : t * c.speed)) % span;
    if (cx < 0) cx += span;
    cx -= 100;
    const dir = c.speed < 0 ? -1 : 1;
    const sz = c.size;
    ctx.globalAlpha = 0.5 + c.depth * 0.5;
    ctx.fillStyle = L.car;
    ctx.fillRect(cx - sz, c.y - sz * 0.18, sz * 2, sz * 0.36);
    ctx.fillRect(cx - sz * 0.5, c.y - sz * 0.34, sz, sz * 0.18);
    ctx.globalAlpha = 0.55 * c.depth;
    ctx.drawImage(glows.tail, cx - dir * sz - sz * 0.6, c.y - sz * 0.6, sz * 1.2, sz * 1.2);
    ctx.globalAlpha = 0.35 * c.depth;
    ctx.drawImage(glows.head, cx + dir * sz - sz * 0.6, c.y - sz * 0.6, sz * 1.2, sz * 1.2);
  }
  ctx.globalAlpha = 1;

  // Rain behind the figures.
  ctx.strokeStyle = L.rain;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const d of drops) {
    const yy = ((d.y + (still ? 0 : t * 0.0006 * d.v)) % 1) * (H + 40) - 20;
    const xx = d.x * W - yy * 0.12;
    ctx.moveTo(xx, yy);
    ctx.lineTo(xx - d.len * 0.12, yy + d.len);
  }
  ctx.stroke();

  // Rooftop and figures.
  ctx.drawImage(front, 0, 0, W, H);
  const { s, roofY, runX, sitX } = figure;
  const pulse = still ? 0.8 : 0.65 + 0.35 * Math.sin(t * 0.0023);
  // Runner's visor.
  ctx.globalAlpha = 0.55 * pulse * boost;
  ctx.drawImage(glows.visor, runX - s * 0.17, roofY - s * 1.0, s * 0.26, s * 0.16);
  ctx.globalAlpha = 1;
  ctx.fillStyle = L.visor;
  ctx.fillRect(runX - 0.065 * s, roofY - 0.94 * s, 0.075 * s, Math.max(1.5, s * 0.012));
  // Netrunner's deck light on the face.
  ctx.globalAlpha = 0.5 * (still ? 0.8 : 0.75 + 0.25 * Math.sin(t * 0.007)) * boost;
  ctx.drawImage(glows.deck, sitX - s * 0.36, roofY - s * 0.42, s * 0.34, s * 0.4);
  ctx.globalAlpha = 1;
  // The drone, bobbing near the runner.
  const dx = runX - s * 0.34 + (still ? 0 : Math.sin(t * 0.0007) * s * 0.05);
  const dy = roofY - s * 1.1 + (still ? 0 : Math.sin(t * 0.0019) * s * 0.03);
  ctx.fillStyle = L.body;
  ctx.fillRect(dx - s * 0.05, dy - s * 0.012, s * 0.1, s * 0.024);
  ctx.fillRect(dx - s * 0.075, dy - s * 0.022, s * 0.04, 1.5);
  ctx.fillRect(dx + s * 0.035, dy - s * 0.022, s * 0.04, 1.5);
  ctx.globalAlpha = 0.6;
  ctx.drawImage(glows.visor, dx - 7, dy - 5, 14, 14);
  ctx.globalAlpha = 1;
  // Antenna beacon.
  const blink = still ? 0.6 : t % 2400 < 300 ? 1 : 0.15;
  ctx.globalAlpha = blink;
  ctx.drawImage(glows.tail, W * 0.6 - 6, roofY - H * 0.22 - 7, 14, 14);
  ctx.globalAlpha = 1;
}

ace.scene({
  init(view) {
    ctx = view.canvas.getContext("2d");
    build(view);
    if (view.reduceMotion) draw(0, true);
  },
  frame(time, view) {
    now = time;
    if (view.width !== W || view.height !== H || view.pixelRatio !== PR || view.scheme !== SCHEME)
      build(view);
    draw(view.reduceMotion ? 0 : time, view.reduceMotion);
  },
  resize(view) {
    build(view);
  },
  scheme() {},
  motion() {},
  signal(name) {
    if (name === "done" || name === "pr-merged") {
      surge = 1;
      surgeAt = now;
    } else if (name === "failed") glitchAt = now;
  },
});
