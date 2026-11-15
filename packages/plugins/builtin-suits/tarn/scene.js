/*
 * Tarn's backdrop: a mountain lake at blue hour. Night in the dark scheme, a pale morning in the
 * light one. Five ridgelines fade into haze, mist drifts between them, and the water holds their
 * reflection with a slow shimmer. Everything is drawn as shapes and gradients each frame, inside
 * a narrow brightness range per scheme, so text over it stays readable and the live check can
 * read every pixel. Little moves, and slowly: mist and cloud drift, the water shimmers, stars
 * breathe and now and then one falls, a few fireflies wander the shore at night, and by day a
 * small flock crosses the sky. A finished run warms the light on the horizon for a moment.
 */

/* Where things sit, as fractions of the window. */
const WATER = 0.8; // the waterline
const GLOW_X = 0.66; // where the light sits on the horizon
const SAMPLES = 220; // points along each ridgeline

const looks = {
  dark: {
    sky: ["#0b0d10", "#13171e", "#212933", "#364454"],
    glow: [150, 171, 195],
    glowAlpha: 0.38,
    ridges: ["#323e4d", "#293340", "#1f2731", "#161b22", "#0e1116"],
    ridgeFoot: ["#435161", "#374452", "#2a343f", "#1e252d", "#14181e"],
    mist: [172, 185, 201],
    mistAlpha: 0.16,
    water: ["#2c3744", "#161c23", "#0c0f13"],
    waterInk: [
      [44, 55, 68],
      [12, 15, 19],
    ],
    reflect: 0.5,
    shimmer: [186, 203, 223],
    shimmerAlpha: 0.2,
    star: [220, 228, 240],
    stars: 1,
    cloudAlpha: 0,
    birds: null,
    fireflies: [206, 220, 238],
  },
  light: {
    sky: ["#dfe5ee", "#e7ebf2", "#eff1f5", "#f8f5f0"],
    glow: [255, 240, 218],
    glowAlpha: 0.85,
    ridges: ["#dce2eb", "#cfd7e2", "#c1cbd9", "#b4c0d0", "#a8b5c7"],
    ridgeFoot: ["#e9edf3", "#dfe5ed", "#d3dbe6", "#c7d1de", "#bbc6d5"],
    mist: [255, 255, 255],
    mistAlpha: 0.42,
    water: ["#eef0f4", "#e2e7ee", "#d6dde7"],
    waterInk: [
      [238, 240, 244],
      [214, 221, 231],
    ],
    reflect: 0.45,
    shimmer: [255, 255, 255],
    shimmerAlpha: 0.5,
    star: [255, 255, 255],
    stars: 0,
    cloudAlpha: 0.55,
    birds: [96, 108, 126],
    fireflies: null,
  },
};

/* Each ridge: how high it reaches, how rough and how sharply peaked it is, and whether pines line its edge. */
const ridgeShapes = [
  { top: 0.44, base: 0.67, rough: 1.1, peak: 0.75, detail: 0.1, seed: 11, pines: 0 },
  { top: 0.53, base: 0.7, rough: 1.4, peak: 0.55, detail: 0.14, seed: 23, pines: 0 },
  { top: 0.61, base: 0.74, rough: 1.8, peak: 0.3, detail: 0.2, seed: 37, pines: 0 },
  { top: 0.675, base: 0.775, rough: 2.3, peak: 0.1, detail: 0.26, seed: 53, pines: 0.5 },
  { top: 0.735, base: 0.795, rough: 3.1, peak: 0, detail: 0.3, seed: 71, pines: 1 },
];

/** A small seeded generator, so the landscape is the same every time. */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth 1D noise in [0, 1] from a table of random values. */
function noise(table, x) {
  const i = Math.floor(x);
  const f = x - i;
  const a = table[((i % table.length) + table.length) % table.length];
  const b = table[(((i + 1) % table.length) + table.length) % table.length];
  const s = f * f * (3 - 2 * f);
  return a + (b - a) * s;
}

/** One ridgeline as heights in [0, 1] (0 its base, 1 its highest peak), left to right. */
function ridgeline(shape) {
  const random = seeded(shape.seed);
  const table = Array.from({ length: 64 }, random);
  const heights = new Array(SAMPLES + 1);
  let low = 1;
  let high = 0;
  for (let i = 0; i <= SAMPLES; i++) {
    const x = (i / SAMPLES) * shape.rough * 3;
    // Rolling hills, turned into sharp crests where the ridge is peaked.
    const roll = noise(table, x) * 0.62 + noise(table, x * 2.3 + 17) * 0.26;
    const crest =
      (1 - Math.abs(2 * noise(table, x * 1.4 + 5) - 1)) * 0.7 +
      (1 - Math.abs(2 * noise(table, x * 3.7 + 29) - 1)) * 0.3;
    const value =
      roll * (1 - shape.peak) +
      crest * shape.peak +
      noise(table, x * 6.1 + 41) * shape.detail * 0.5;
    heights[i] = value;
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  for (let i = 0; i <= SAMPLES; i++) heights[i] = (heights[i] - low) / (high - low || 1);
  // Pines: small notches along the edge, taller on the nearer ridge.
  const pines = [];
  if (shape.pines > 0) {
    for (let i = 0; i < SAMPLES; i += 1) {
      if (random() < 0.55) pines.push({ at: i + random(), size: 0.5 + random() * 0.5 });
    }
  }
  return { heights, pines };
}

const ridges = ridgeShapes.map(ridgeline);

let ctx;
let stars = [];
let dashes = [];
let mistBands = [];
let clouds = [];
let fireflies = [];
let warmAt = -1e9;
let now = 0;

function scatter() {
  const random = seeded(97);
  stars = Array.from({ length: 150 }, () => ({
    x: random(),
    y: random() * random() * 0.6,
    size: 0.6 + random() * 1.1,
    alpha: 0.25 + random() * 0.6,
    pace: random() < 0.4 ? 0.5 + random() * 1.1 : 0,
    phase: random() * 6.283,
  }));
  dashes = Array.from({ length: 46 }, () => ({
    x: random(),
    y: random() * random(),
    length: 0.012 + random() * 0.05,
    alpha: 0.35 + random() * 0.65,
    pace: 0.5 + random(),
    phase: random() * 6.283,
  }));
  mistBands = [
    { y: 0.69, height: 0.07, pace: 0.000011, offset: 0.1, alpha: 0.8 },
    { y: 0.74, height: 0.06, pace: -0.000015, offset: 0.55, alpha: 1 },
    { y: 0.785, height: 0.045, pace: 0.00002, offset: 0.3, alpha: 0.9 },
  ];
  clouds = [
    { y: 0.19, height: 0.03, reach: 0.13, lobes: 2, pace: 0.000007, offset: 0.05, alpha: 1 },
    { y: 0.3, height: 0.024, reach: 0.1, lobes: 2, pace: 0.00001, offset: 0.4, alpha: 0.8 },
  ];
  fireflies = Array.from({ length: 14 }, () => ({
    x: random(),
    y: 0.7 + random() * 0.09,
    drift: 0.012 + random() * 0.02,
    pace: 0.3 + random() * 0.5,
    phase: random() * 6.283,
  }));
}

const rgba = (colour, alpha) => `rgba(${colour[0]},${colour[1]},${colour[2]},${alpha})`;

/** The path of ridge `index` across `width`, from its base at `foot` up to its peaks. */
function trace(index, width, height, flip) {
  const shape = ridgeShapes[index];
  const { heights, pines } = ridges[index];
  const water = WATER * height;
  const rise = (shape.base - shape.top) * height;
  const base = shape.base * height;
  // Mirrored in the water: the same outline, hung below the waterline and pressed flatter.
  const y = (value) =>
    flip ? water + (water - (base - value * rise)) * 0.62 : base - value * rise;
  ctx.beginPath();
  ctx.moveTo(0, flip ? water : water + 1);
  for (let i = 0; i <= SAMPLES; i++) ctx.lineTo((i / SAMPLES) * width, y(heights[i]));
  ctx.lineTo(width, flip ? water : water + 1);
  ctx.closePath();
  ctx.fill();
  if (pines.length === 0 || flip) return;
  const tall = shape.pines * Math.max(5, height * 0.011);
  ctx.beginPath();
  for (const pine of pines) {
    const i = Math.floor(pine.at);
    const here = heights[i] + (heights[Math.min(SAMPLES, i + 1)] - heights[i]) * (pine.at - i);
    const x = (pine.at / SAMPLES) * width;
    const foot = y(here) + 1;
    const size = tall * pine.size;
    ctx.moveTo(x - size * 0.32, foot);
    ctx.lineTo(x, foot - size);
    ctx.lineTo(x + size * 0.32, foot);
  }
  ctx.fill();
}

function draw(time, view) {
  const { width, height, pixelRatio } = view;
  const look = looks[view.scheme === "light" ? "light" : "dark"];
  const still = view.reduceMotion;
  const t = still ? 0 : time;
  const water = WATER * height;
  // A finished run warms the horizon: up quickly, then two seconds back down.
  const since = time - warmAt;
  const warm = still || since < 0 || since > 2400 ? 0 : Math.sin((since / 2400) * Math.PI) ** 2;

  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.globalAlpha = 1;

  // Sky.
  const sky = ctx.createLinearGradient(0, 0, 0, water);
  sky.addColorStop(0, look.sky[0]);
  sky.addColorStop(0.45, look.sky[1]);
  sky.addColorStop(0.8, look.sky[2]);
  sky.addColorStop(1, look.sky[3]);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, water + 1);

  // The light on the horizon.
  const reach = Math.max(width, height) * 0.5;
  const glow = ctx.createRadialGradient(GLOW_X * width, water, 0, GLOW_X * width, water, reach);
  const strength = look.glowAlpha * (1 + warm * 0.45);
  glow.addColorStop(0, rgba(look.glow, strength));
  glow.addColorStop(0.35, rgba(look.glow, strength * 0.42));
  glow.addColorStop(1, rgba(look.glow, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, water + 1);

  // Stars, a few of them breathing.
  if (look.stars) {
    for (const star of stars) {
      const breath = star.pace ? 0.65 + 0.35 * Math.sin(t * 0.001 * star.pace + star.phase) : 1;
      ctx.fillStyle = rgba(look.star, star.alpha * breath * 0.8);
      ctx.fillRect(star.x * width, star.y * height, star.size, star.size);
    }
    if (!still) fallingStar(t, width, height, look);
  }
  if (look.cloudAlpha)
    for (const cloud of clouds) mist(cloud, t, width, height, look, look.cloudAlpha);
  if (look.birds && !still) flock(t, width, height, look);

  // Ridges from far to near, each fading into haze at its foot, with mist between them.
  for (let index = 0; index < ridgeShapes.length; index++) {
    const shape = ridgeShapes[index];
    const fill = ctx.createLinearGradient(0, shape.top * height, 0, water);
    fill.addColorStop(0, look.ridges[index]);
    fill.addColorStop(1, look.ridgeFoot[index]);
    ctx.fillStyle = fill;
    trace(index, width, height, false);
    const band = mistBands[index - 1];
    if (band) mist(band, t, width, height, look, look.mistAlpha);
    // Fireflies wander in front of the middle ridges, behind the near shore.
    if (index === 3 && look.fireflies) glimmer(t, width, height, look, still);
  }

  // Water: the sky's colour deepening, the ridges mirrored in it, then the light and shimmer.
  const lake = ctx.createLinearGradient(0, water, 0, height);
  lake.addColorStop(0, look.water[0]);
  lake.addColorStop(0.4, look.water[1]);
  lake.addColorStop(1, look.water[2]);
  ctx.fillStyle = lake;
  ctx.fillRect(0, water, width, height - water);

  ctx.globalAlpha = look.reflect;
  for (let index = 1; index < ridgeShapes.length; index++) {
    ctx.fillStyle = look.ridges[index];
    trace(index, width, height, true);
  }
  ctx.globalAlpha = 1;

  // The water darkens the mirror image with depth.
  const depth = ctx.createLinearGradient(0, water, 0, height);
  depth.addColorStop(0, rgba(look.waterInk[0], 0.1));
  depth.addColorStop(1, rgba(look.waterInk[1], 0.92));
  ctx.fillStyle = depth;
  ctx.fillRect(0, water, width, height - water);

  // The light's path across the water.
  const path = ctx.createRadialGradient(
    GLOW_X * width,
    water,
    0,
    GLOW_X * width,
    water,
    reach * 0.7,
  );
  path.addColorStop(0, rgba(look.glow, strength * 0.5));
  path.addColorStop(1, rgba(look.glow, 0));
  ctx.fillStyle = path;
  ctx.fillRect(0, water, width, height - water);

  for (const dash of dashes) {
    const y = water + 3 + dash.y * (height - water - 6);
    const far = 1 - dash.y;
    const near = 1 - Math.min(1, Math.abs(dash.x - GLOW_X) * 2.2);
    const breath = 0.5 + 0.5 * Math.sin(t * 0.0007 * dash.pace + dash.phase);
    const x = ((dash.x + t * 0.000004 * dash.pace) % 1) * width;
    ctx.fillStyle = rgba(
      look.shimmer,
      look.shimmerAlpha * dash.alpha * breath * (0.35 + 0.65 * near) * (0.4 + 0.6 * far),
    );
    ctx.fillRect(x, y, dash.length * width * (0.5 + 0.5 * dash.y), 1);
  }

  // The waterline: one thin line of light.
  const line = ctx.createLinearGradient(0, 0, width, 0);
  line.addColorStop(0, rgba(look.shimmer, 0));
  line.addColorStop(GLOW_X, rgba(look.shimmer, look.shimmerAlpha * 1.4));
  line.addColorStop(1, rgba(look.shimmer, 0));
  ctx.fillStyle = line;
  ctx.fillRect(0, water - 0.5, width, 1);
}

/** One band of mist or cloud: a few soft lobes that drift along it and wrap round. */
function mist(band, t, width, height, look, strength) {
  const y = band.y * height;
  const tall = band.height * height;
  const lobes = band.lobes ?? 3;
  for (let lobe = 0; lobe < lobes; lobe++) {
    const along = (((band.offset + lobe / lobes + t * band.pace) % 1) + 1) % 1;
    const x = (along * 1.6 - 0.3) * width;
    const reach = width * ((band.reach ?? 0.34) + lobe * 0.05);
    const fog = ctx.createRadialGradient(x, y, 0, x, y, reach);
    fog.addColorStop(0, rgba(look.mist, strength * band.alpha));
    fog.addColorStop(1, rgba(look.mist, 0));
    ctx.fillStyle = fog;
    // Pressed flat: a wide, shallow ellipse of fog.
    ctx.save();
    ctx.translate(0, y);
    ctx.scale(1, tall / reach);
    ctx.translate(0, -y);
    ctx.fillRect(x - reach, y - reach, reach * 2, reach * 2);
    ctx.restore();
  }
}

/** A number in [0, 1) that is the same for the same `n` and `salt`, with nothing kept. */
function chance(n, salt) {
  const value = Math.sin(n * 12.9898 + salt * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

/** Now and then a star falls: a short streak that fades at both ends, in a new place each time. */
function fallingStar(t, width, height, look) {
  const every = 16000;
  const lasts = 1100;
  const turn = Math.floor(t / every);
  const since = t - turn * every - every * 0.4;
  if (since < 0 || since > lasts) return;
  const p = since / lasts;
  const fromX = (0.12 + chance(turn, 1) * 0.7) * width;
  const fromY = (0.05 + chance(turn, 2) * 0.24) * height;
  const reach = (0.11 + chance(turn, 3) * 0.08) * width;
  const fall = reach * (0.32 + chance(turn, 4) * 0.2);
  const side = chance(turn, 5) < 0.5 ? -1 : 1;
  const headX = fromX + side * reach * p;
  const headY = fromY + fall * p;
  const tail = Math.min(p, 0.32);
  const tailX = fromX + side * reach * (p - tail);
  const tailY = fromY + fall * (p - tail);
  const streak = ctx.createLinearGradient(tailX, tailY, headX, headY);
  streak.addColorStop(0, rgba(look.star, 0));
  streak.addColorStop(1, rgba(look.star, 0.85 * Math.sin(p * Math.PI)));
  ctx.strokeStyle = streak;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(tailX, tailY);
  ctx.lineTo(headX, headY);
  ctx.stroke();
}

/** Fireflies: small lights that wander a little and glow on and off, each at its own pace. */
function glimmer(t, width, height, look, still) {
  for (const fly of fireflies) {
    const turn = still ? fly.phase : t * 0.00022 * fly.pace + fly.phase;
    const x = (fly.x + Math.sin(turn) * fly.drift) * width;
    const y = (fly.y + Math.sin(turn * 1.7 + fly.phase) * fly.drift * 0.4) * height;
    const glow = still ? 0.5 : Math.max(0, Math.sin(t * 0.0011 * fly.pace + fly.phase * 3));
    if (glow <= 0.02) continue;
    ctx.fillStyle = rgba(look.fireflies, 0.1 * glow);
    ctx.fillRect(x - 2.5, y - 2.5, 5, 5);
    ctx.fillStyle = rgba(look.fireflies, 0.75 * glow);
    ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
  }
}

/** By day a small flock crosses the sky now and then, wings beating slowly. */
function flock(t, width, height, look) {
  const every = 30000;
  const lasts = 19000;
  const turn = Math.floor(t / every);
  const since = t - turn * every - every * 0.15;
  if (since < 0 || since > lasts) return;
  const p = since / lasts;
  const leftward = chance(turn, 6) < 0.5;
  const along = leftward ? 1.08 - p * 1.16 : -0.08 + p * 1.16;
  const high = 0.16 + chance(turn, 7) * 0.16;
  const span = Math.max(4, width * 0.0042);
  ctx.strokeStyle = rgba(look.birds, 0.5);
  ctx.lineWidth = 1.1;
  ctx.lineCap = "round";
  ctx.beginPath();
  for (let bird = 0; bird < 5; bird++) {
    // A loose V behind the leader, each bird a little out of step with the rest.
    const rank = Math.ceil(bird / 2);
    const wing = bird % 2 === 0 ? 1 : -1;
    const x = (along - (leftward ? -1 : 1) * rank * 0.012) * width;
    const y = (high + wing * rank * 0.011 - p * 0.04) * height + Math.sin(t * 0.0012 + bird) * 1.5;
    const beat = Math.sin(t * 0.0075 + bird * 1.3) * span * 0.45;
    ctx.moveTo(x - span, y - beat);
    ctx.lineTo(x, y);
    ctx.lineTo(x + span, y - beat);
  }
  ctx.stroke();
}

ace.scene({
  init(view) {
    ctx = view.canvas.getContext("2d", { alpha: false });
    scatter();
  },
  frame(time, view) {
    now = time;
    draw(time, view);
  },
  signal(name) {
    if (name === "done" || name === "pr-merged") warmAt = now;
  },
});
