/*
 * Loam's backdrop: a little block world in pixel art. Rolling grass hills over dirt and stone
 * (with ore flecks), blocky trees, a pond, an oak cabin with a stone base, and two original
 * characters: an explorer in a straw hat and red scarf who wanders, stops and mines, and a small
 * tan dog who follows. Day in the light scheme; a starry night with torches, a lit window and a
 * lantern in the dark one. The world is painted once per size and scheme into a low-resolution
 * canvas; each frame draws sky things and sprites at that resolution and scales it up crisply.
 */

const C = {
  skyDay: [
    [120, 186, 236],
    [200, 230, 246],
  ],
  skyNight: [
    [14, 20, 46],
    [46, 56, 102],
  ],
  farDay: [150, 196, 160],
  farNight: [38, 52, 68],
  grass: [
    [95, 158, 59],
    [116, 179, 71],
    [84, 142, 52],
  ],
  dirt: [
    [134, 98, 66],
    [122, 85, 54],
    [146, 108, 72],
    [108, 74, 46],
  ],
  stone: [
    [128, 128, 126],
    [116, 116, 114],
    [140, 140, 137],
    [104, 104, 102],
  ],
  ore: [
    [40, 40, 40],
    [212, 170, 120],
    [96, 210, 214],
  ],
  trunk: [
    [107, 74, 43],
    [92, 62, 35],
  ],
  leaves: [
    [63, 127, 42],
    [76, 143, 50],
    [52, 110, 36],
  ],
  plank: [
    [176, 136, 84],
    [160, 122, 74],
    [190, 150, 96],
  ],
  darkPlank: [
    [92, 64, 40],
    [80, 55, 34],
  ],
  cobble: [
    [122, 122, 120],
    [100, 100, 98],
    [142, 142, 140],
  ],
  water: [
    [56, 116, 200],
    [72, 132, 214],
  ],
  glassDay: [170, 214, 236],
  lit: [255, 206, 110],
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
function noise1(seed, n) {
  const r = seeded(seed);
  const pts = Array.from({ length: n + 2 }, () => r());
  return (x) => {
    const i = Math.floor(x),
      f = x - i,
      u = f * f * (3 - 2 * f);
    return pts[i % pts.length] * (1 - u) + pts[(i + 1) % pts.length] * u;
  };
}
function canvas(w, h) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}
const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

/* Sprites: one character per art pixel. */
const EXPLORER = [
  "...hhhh...",
  "..hhhhhh..",
  ".bbbbbbbb.",
  "..kssssk..",
  "..sesses..",
  "..ssssss..",
  "...rrrr...",
  ".trrrrrrt.",
  ".tttrtttt.",
  ".tttttttt.",
  ".tttttttt.",
  ".s.tttt.s.",
  "...lyll...",
  "...pppp...",
  "...pp.pp..",
  "...pp.pp..",
  "...pp.pp..",
  "...oo.oo..",
];
const EXPLORER_STEP = ["...pppp...", "...pp.pp..", "..pp...pp.", "..pp...pp.", "..oo...oo."];
const DOG = [
  "........ee..",
  "........dddd",
  "t.......dDdn",
  ".t.dddddddd.",
  "..ddddddddd.",
  "..dddddddd..",
  "..d.d..d.d..",
  "..o.o..o.o..",
];
const DOG_STEP = ["..d..d.d..d.", ".o..o...o..o"];
const PAL = {
  h: [216, 180, 90],
  b: [176, 139, 60],
  k: [74, 48, 32],
  s: [224, 180, 138],
  e: [42, 30, 22],
  r: [200, 69, 47],
  t: [200, 105, 46],
  l: [74, 48, 32],
  y: [227, 194, 106],
  p: [91, 70, 54],
  o: [46, 36, 28],
  d: [199, 154, 98],
  D: [42, 30, 22],
  n: [42, 30, 22],
  t2: [199, 154, 98],
};
const DOGPAL = {
  e: [138, 100, 64],
  d: [199, 154, 98],
  D: [42, 30, 22],
  n: [42, 30, 22],
  t: [199, 154, 98],
  o: [138, 100, 64],
};

let ctx, W, H, PR, SCHEME, P, gw, gh, night;
let lo, lg, world, glowWarm, glowCool;
let ground = [],
  clouds = [],
  stars = [],
  birds = [],
  flies = [];
let site = {};
let now = 0,
  hopAt = -Infinity;

function shade(c, emissive) {
  if (!night || emissive) return c;
  return [c[0] * 0.46 + 12, c[1] * 0.5 + 14, c[2] * 0.66 + 30];
}

function build(view) {
  W = view.width;
  H = view.height;
  PR = view.pixelRatio;
  SCHEME = view.scheme;
  night = SCHEME !== "light";
  P = Math.max(3, Math.min(6, Math.round(H / 170)));
  gw = Math.ceil(W / P);
  gh = Math.ceil(H / P);
  lo = canvas(gw, gh);
  lg = lo.getContext("2d");
  world = canvas(gw, gh);
  const wg = world.getContext("2d");
  const img = wg.createImageData(gw, gh);
  const px = img.data;
  const rnd = seeded(4242);
  const set = (x, y, c, emissive) => {
    if (x < 0 || y < 0 || x >= gw || y >= gh) return;
    const k = (y * gw + x) * 4,
      v = shade(c, emissive);
    px[k] = v[0];
    px[k + 1] = v[1];
    px[k + 2] = v[2];
    px[k + 3] = 255;
  };
  const pick = (arr) => arr[(rnd() * arr.length) | 0];

  // Sky in bands, the way a low-colour palette would draw it.
  const sky = night ? C.skyNight : C.skyDay;
  for (let y = 0; y < gh; y++) {
    const t = Math.min(1, Math.floor((y / (gh * 0.7)) * 10) / 10);
    const c = [0, 1, 2].map((i) => sky[0][i] + (sky[1][i] - sky[0][i]) * t);
    for (let x = 0; x < gw; x++) {
      const k = (y * gw + x) * 4;
      px[k] = c[0];
      px[k + 1] = c[1];
      px[k + 2] = c[2];
      px[k + 3] = 255;
    }
  }

  // Far hills: stepped, flat-coloured, hazy.
  const nf = noise1(7, 64);
  const far = night ? C.farNight : C.farDay;
  for (let x = 0; x < gw; x++) {
    const top = Math.round((gh * (0.5 + nf(x / 38) * 0.14)) / 4) * 4;
    for (let y = top; y < gh; y++)
      for (let i = 0; i < 1; i++) {
        const k = (y * gw + x) * 4;
        px[k] = far[0];
        px[k + 1] = far[1];
        px[k + 2] = far[2];
      }
  }

  // Near terrain in 8-pixel blocks, flat where the cabin and the explorer's path are.
  const B = 8;
  const nn = noise1(19, 64);
  const flatFrom = Math.floor((gw * 0.6) / B) * B;
  const flatY = Math.round((gh * 0.76) / B) * B;
  const pondFrom = Math.floor((gw * 0.38) / B) * B,
    pondTo = pondFrom + B * 5;
  ground = Array.from({ length: gw });
  for (let bx = 0; bx < gw; bx += B) {
    let top = Math.round((gh * (0.66 + nn(bx / 60) * 0.14)) / B) * B;
    if (bx >= flatFrom) top = flatY;
    else if (bx >= flatFrom - B * 3) top = Math.round((top + flatY) / 2 / B) * B;
    // The pond sits in a flat clearing: level banks, a dip one or two blocks deep.
    if (bx >= pondFrom - B * 2 && bx < pondTo + B * 2) top = flatY;
    if (bx >= pondFrom && bx < pondTo) top = flatY + (bx > pondFrom && bx < pondTo - B ? B * 2 : B);
    for (let x = bx; x < Math.min(gw, bx + B); x++) {
      ground[x] = top;
      for (let y = top; y < gh; y++) {
        const depth = y - top;
        const edge = (x - bx === B - 1 || (y - top) % B === B - 1) && depth >= 3;
        let c;
        if (depth < 2) c = pick(C.grass);
        else if (depth < 3) c = rnd() < 0.5 ? C.grass[2] : C.dirt[0];
        else if (depth < B * 3) c = pick(C.dirt);
        else {
          c = pick(C.stone);
          if (rnd() < 0.012) c = pick(C.ore);
        }
        if (edge) c = c.map((v) => v * 0.86);
        set(x, y, c);
      }
    }
  }
  // Pond water, a block deep, filled to the bank.
  const waterTop = flatY;
  for (let x = pondFrom; x < pondTo && x < gw; x++)
    for (let y = waterTop + 2; y < ground[x]; y++) set(x, y, C.water[(x + y) % 2]);
  site.pond = { from: pondFrom, to: Math.min(gw, pondTo), y: waterTop + 2 };

  // Trees.
  const tree = (tx) => {
    const base = ground[Math.min(gw - 1, tx + 2)];
    const tall = 14 + ((rnd() * 8) | 0);
    for (let y = base - tall; y < base; y++)
      for (let x = tx; x < tx + 4; x++) set(x, y, (x + y) % 3 ? C.trunk[0] : C.trunk[1]);
    const cy = base - tall - 4;
    for (let y = cy - 12; y < cy + 6; y++)
      for (let x = tx - 10; x < tx + 14; x++) {
        const corner = (y < cy - 8 || y > cy + 2) && (x < tx - 6 || x > tx + 9);
        if (!corner) set(x, y, pick(C.leaves));
      }
  };
  [0.08, 0.2, 0.31, 0.53, 0.97].forEach((f) => tree(Math.round(gw * f) + ((rnd() * 6) | 0)));

  // The cabin: stone base, oak plank walls, a stepped dark-oak roof, a door and a window.
  const cx = Math.round(gw * 0.74),
    cw = 40,
    ch = 26,
    base = flatY;
  for (let y = base - 6; y < base; y++)
    for (let x = cx; x < cx + cw; x++) set(x, y, pick(C.cobble));
  for (let y = base - ch; y < base - 6; y++)
    for (let x = cx; x < cx + cw; x++) {
      const seam = (y - (base - ch)) % 4 === 3;
      const post = x === cx || x === cx + cw - 1 || x === cx + 1 || x === cx + cw - 2;
      set(x, y, post ? C.darkPlank[0] : seam ? C.plank[1] : C.plank[(x >> 3) % 2 ? 0 : 2]);
    }
  for (let step = 0; step < 6; step++) {
    const y0 = base - ch - (step + 1) * 3;
    for (let y = y0; y < y0 + 3; y++)
      for (let x = cx - 4 + step * 4; x < cx + cw + 4 - step * 4; x++)
        set(x, y, C.darkPlank[(x + y) % 2]);
  }
  const door = { x: cx + 6, y: base - 20, w: 9, h: 14 };
  for (let y = door.y; y < base - 6 + 6; y++)
    for (let x = door.x; x < door.x + door.w; x++)
      set(x, y, x === door.x + 6 && y === door.y + 7 ? [200, 170, 90] : C.darkPlank[(y >> 2) % 2]);
  const win = { x: cx + 23, y: base - 20, w: 10, h: 8 };
  for (let y = win.y; y < win.y + win.h; y++)
    for (let x = win.x; x < win.x + win.w; x++) {
      const frame =
        x === win.x ||
        y === win.y ||
        x === win.x + win.w - 1 ||
        y === win.y + win.h - 1 ||
        x === win.x + 5 ||
        y === win.y + 4;
      set(x, y, frame ? C.darkPlank[0] : night ? C.lit : C.glassDay, !frame && night);
    }
  site.cabin = { x: cx, w: cw, base, door, win };
  site.torches = [cx - 4, cx + cw + 2].map((x) => ({ x, y: base - 10 }));
  for (const t of site.torches) for (let y = t.y + 2; y < base; y++) set(t.x, y, C.trunk[0]);

  wg.putImageData(img, 0, 0);

  site.walk = { from: Math.round(gw * 0.6), to: Math.round(gw * 0.95), y: flatY };
  site.mine = Math.round(gw * 0.63);

  // Moving things.
  clouds = Array.from({ length: 7 }, () => ({
    x: rnd() * gw,
    y: 6 + rnd() * gh * 0.22,
    w: 16 + ((rnd() * 28) | 0),
    v: 0.002 + rnd() * 0.003,
  }));
  stars = Array.from({ length: 70 }, () => ({
    x: (rnd() * gw) | 0,
    y: (rnd() * gh * 0.42) | 0,
    p: rnd() * 6,
  }));
  birds = Array.from({ length: 4 }, (_, i) => ({
    x: rnd() * gw,
    y: gh * (0.12 + rnd() * 0.18),
    v: 0.006 + rnd() * 0.004,
    p: i,
  }));
  flies = Array.from({ length: 10 }, () => ({
    x: gw * (0.55 + rnd() * 0.42),
    y: flatY - 6 - rnd() * 22,
    p: rnd() * 10,
  }));

  glowWarm = glow([255, 190, 90]);
  glowCool = glow([210, 255, 150]);
}

function glow(c) {
  const g = canvas(64, 64);
  const x = g.getContext("2d");
  const grad = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, rgb(c, 0.8));
  grad.addColorStop(0.4, rgb(c, 0.25));
  grad.addColorStop(1, rgb(c, 0));
  x.fillStyle = grad;
  x.fillRect(0, 0, 64, 64);
  return g;
}

function sprite(rows, pal, x, y, flip, extraPal) {
  const w = rows[0].length;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let i = 0; i < w; i++) {
      const ch = row[i];
      if (ch === ".") continue;
      const c = (extraPal && extraPal[ch]) || pal[ch];
      if (!c) continue;
      lg.fillStyle = rgb(shade(c));
      lg.fillRect(flip ? x + w - 1 - i : x + i, y + r, 1, 1);
    }
  }
}

/** Where the explorer is at time t: walk, stop to mine, walk back, rest by the cabin. */
function explorerAt(t) {
  const { from, to } = site.walk;
  const span = to - from;
  const speed = 0.006; // art px per ms
  const walkMs = span / speed;
  const cycle = walkMs * 2 + 9000;
  const k = t % cycle;
  if (k < walkMs) return { x: to - k * speed, dir: -1, moving: true };
  if (k < walkMs + 5000) return { x: from, dir: -1, moving: false, mining: true, k: k - walkMs };
  if (k < walkMs * 2 + 5000) return { x: from + (k - walkMs - 5000) * speed, dir: 1, moving: true };
  return { x: to, dir: -1, moving: false, k: k - walkMs * 2 - 5000 };
}

function draw(t, still) {
  lg.setTransform(1, 0, 0, 1, 0, 0);
  lg.drawImage(world, 0, 0);

  // Sun or moon.
  const sx = Math.round(gw * 0.86),
    sy = Math.round(gh * 0.12);
  if (night) {
    lg.fillStyle = "rgb(226,230,240)";
    lg.fillRect(sx, sy, 12, 12);
    lg.fillStyle = "rgb(190,196,212)";
    lg.fillRect(sx + 3, sy + 3, 2, 2);
    lg.fillRect(sx + 7, sy + 7, 3, 2);
    for (const s of stars) {
      const tw = still ? 1 : 0.55 + 0.45 * Math.sin(t * 0.0015 + s.p);
      lg.fillStyle = `rgba(230,236,255,${0.35 + 0.5 * tw})`;
      lg.fillRect(s.x, s.y, 1, 1);
    }
  } else {
    lg.fillStyle = "rgb(255,236,150)";
    lg.fillRect(sx - 2, sy - 2, 16, 16);
    lg.fillStyle = "rgb(255,248,200)";
    lg.fillRect(sx, sy, 12, 12);
  }

  // Clouds: flat blocky slabs drifting.
  for (const c of clouds) {
    const x = Math.round(((c.x + (still ? 0 : t * c.v)) % (gw + 60)) - 50);
    const y = Math.round(c.y);
    lg.fillStyle = night ? "rgba(70,80,110,0.55)" : "rgba(255,255,255,0.92)";
    lg.fillRect(x, y, c.w, 4);
    lg.fillRect(x + 4, y - 3, c.w - 10, 3);
    lg.fillStyle = night ? "rgba(50,58,84,0.55)" : "rgba(222,236,246,0.95)";
    lg.fillRect(x, y + 4, c.w, 2);
  }

  // Birds by day.
  if (!night)
    for (const b of birds) {
      const x = Math.round((b.x + (still ? 0 : t * b.v)) % (gw + 20)) - 10;
      const y = Math.round(b.y + (still ? 0 : Math.sin(t * 0.002 + b.p) * 2));
      const up = still ? 0 : Math.floor(t / 260 + b.p) % 2;
      lg.fillStyle = "rgba(60,70,90,0.8)";
      lg.fillRect(x, y, 1, 1);
      lg.fillRect(x - 1, y - 1 + up, 1, 1);
      lg.fillRect(x + 1, y - 1 + up, 1, 1);
    }

  // Pond shimmer.
  const pd = site.pond;
  for (let x = pd.from; x < pd.to; x += 3) {
    if (still || Math.floor(t / 400 + x) % 4 === 0) {
      lg.fillStyle = night ? "rgba(140,170,230,0.35)" : "rgba(220,240,255,0.8)";
      lg.fillRect(x, pd.y, 2, 1);
    }
  }

  // Torch flames.
  for (const tc of site.torches) {
    const f = still ? 0 : Math.floor(t / 140 + tc.x) % 3;
    lg.fillStyle = "rgb(255,214,90)";
    lg.fillRect(tc.x, tc.y, 1, 2);
    lg.fillStyle = "rgb(255,140,40)";
    lg.fillRect(tc.x, tc.y - (f === 1 ? 1 : 0), 1, 1);
  }

  // The explorer and the dog.
  const ex = explorerAt(still ? 1e9 : t);
  if (still) Object.assign(ex, { x: site.cabin.x - 16, dir: 1, moving: false, mining: false });
  const gy = site.walk.y;
  const hop = Math.max(0, 1 - (t - hopAt) / 600);
  const jump = Math.round(Math.sin(hop * Math.PI) * 6);
  const step = ex.moving && Math.floor(t / 180) % 2;
  const bob = ex.moving && step ? 1 : 0;
  const exX = Math.round(ex.x);
  const exY = gy - EXPLORER.length - jump + bob - (bob ? 1 : 0);
  const flip = ex.dir < 0;
  const body = step ? EXPLORER.slice(0, 13).concat(EXPLORER_STEP) : EXPLORER;
  sprite(body, PAL, exX, exY, flip);
  // Pickaxe while mining (swinging), lantern at night otherwise.
  const hand = { x: flip ? exX : exX + 9, y: exY + 11 };
  if (ex.mining) {
    const up = Math.floor(ex.k / 300) % 2 === 0;
    lg.fillStyle = rgb(shade([107, 74, 43]));
    for (let i = 0; i < 6; i++)
      lg.fillRect(hand.x + (flip ? -i : i) * (up ? 0.5 : 1), hand.y - (up ? i : i * 0.4), 1, 1);
    lg.fillStyle = rgb(shade([170, 176, 180]));
    const hx = hand.x + (flip ? -1 : 1) * (up ? 3 : 6),
      hy = hand.y - (up ? 6 : 3);
    lg.fillRect(hx - 2, hy, 5, 1);
    lg.fillRect(hx - 3, hy + 1, 1, 1);
    lg.fillRect(hx + 3, hy + 1, 1, 1);
    if (!up && !still) {
      lg.fillStyle = "rgba(170,170,165,0.9)";
      lg.fillRect(hx + (flip ? -5 : 5), hy + 2 - (Math.floor(ex.k / 150) % 3), 1, 1);
    }
  } else if (night) {
    lg.fillStyle = "rgb(60,56,52)";
    lg.fillRect(hand.x, hand.y, 3, 1);
    lg.fillStyle = "rgb(255,210,110)";
    lg.fillRect(hand.x, hand.y + 1, 3, 3);
  }
  // Dog: trails the explorer, wags while still.
  const dogX = Math.round(ex.x + (flip ? 14 : -14));
  const dogRows = ex.moving && step ? DOG.slice(0, 6).concat(DOG_STEP) : DOG.slice();
  if (!ex.moving && !still && Math.floor(t / 220) % 2)
    dogRows[2] = "t" + dogRows[2].slice(1).replace(/^t/, ".");
  if (!ex.moving && !still && Math.floor(t / 220) % 2 === 0) {
    dogRows[2] = "." + dogRows[2].slice(1);
    dogRows[1] = "t" + dogRows[1].slice(1);
  }
  sprite(dogRows, DOGPAL, dogX, gy - DOG.length - Math.round(jump / 2), flip);

  // Fireflies at night.
  if (night)
    for (const f of flies) {
      const on = still ? 1 : 0.5 + 0.5 * Math.sin(t * 0.003 + f.p);
      const x = Math.round(f.x + (still ? 0 : Math.sin(t * 0.0007 + f.p) * 6));
      const y = Math.round(f.y + (still ? 0 : Math.cos(t * 0.0009 + f.p) * 3));
      lg.fillStyle = `rgba(220,255,150,${0.3 + 0.7 * on})`;
      lg.fillRect(x, y, 1, 1);
      f.sx = x;
      f.sy = y;
      f.on = on;
    }

  // Scale up crisply.
  ctx.setTransform(PR, 0, 0, PR, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(lo, 0, 0, gw * P, gh * P);

  // Soft light on top, at full resolution: torches, window, lantern, fireflies.
  if (night) {
    const flick = still ? 1 : 0.85 + 0.15 * Math.sin(t * 0.02);
    ctx.globalAlpha = 0.55 * flick;
    for (const tc of site.torches)
      ctx.drawImage(glowWarm, (tc.x - 9) * P, (tc.y - 9) * P, 19 * P, 19 * P);
    const w = site.cabin.win;
    ctx.globalAlpha = 0.4;
    ctx.drawImage(glowWarm, (w.x - 8) * P, (w.y - 8) * P, (w.w + 16) * P, (w.h + 16) * P);
    if (!ex.mining) {
      ctx.globalAlpha = 0.6 * flick;
      ctx.drawImage(glowWarm, (hand.x - 8) * P, (hand.y - 7) * P, 18 * P, 18 * P);
    }
    ctx.globalAlpha = 1;
    for (const f of flies) {
      ctx.globalAlpha = 0.45 * f.on;
      ctx.drawImage(glowCool, (f.sx - 3) * P, (f.sy - 3) * P, 7 * P, 7 * P);
    }
    ctx.globalAlpha = 1;
  }
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
  signal(name) {
    // A finished run or a merged pull request: the explorer and the dog hop for joy.
    if (name === "done" || name === "pr-merged") hopAt = now;
  },
});
