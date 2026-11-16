/*
 * Palm Haze's backdrop: an original sunset coast, drawn and animated in code.
 *
 * A big sun sinks into the sea, its reflection shimmering; a speedboat cuts a wake across the
 * water. On the right, art-deco hotels glow with pink and teal neon. Palms sway along the
 * beach. On the boardwalk someone strolls in shades and a skater pushes and glides; on the
 * boulevard a teal convertible cruises by, the passenger's hair streaming, lights on. Gulls
 * flap overhead and a far helicopter blinks. Light scheme: a bright afternoon on the same coast.
 *
 * Static layers are painted once per size and scheme; each frame draws only what moves.
 */

const LOOK = {
  dark: {
    sky: [
      [0, "#1d1238"],
      [0.3, "#4a1a5c"],
      [0.55, "#a8326e"],
      [0.72, "#ec6a52"],
      [0.86, "#ffb05a"],
      [1, "#ffd27a"],
    ],
    sun: [
      [255, 235, 160],
      [255, 120, 90],
    ],
    sunA: 1,
    glow: [255, 130, 120],
    cloud: [255, 140, 150],
    cloudA: 0.35,
    sea: ["#5a2a6a", "#2a1640", "#160c26"],
    shimmer: [255, 200, 140],
    sand: ["#3a2434", "#2c1a2a"],
    walk: "#22141f",
    road: "#140d17",
    lane: "rgba(255,200,150,0.35)",
    hotel: ["#2a1630", "#24122a", "#1d0f22"],
    window: [255, 190, 130],
    neon: ["#ff4fa3", "#33e0d0", "#ffb35a"],
    palm: "#140a14",
    frond: "#1a0d18",
    rim: "rgba(255,140,120,0.9)",
    skin: "#6a4038",
    cloth: ["#2d6f8f", "#e0e0d8", "#d9446e", "#2b2b33", "#f2b04a"],
    body: "#1b1018",
    car: ["#1fa7a3", "#0f5e5c"],
    chrome: "#e8d6c8",
    tyre: "#0d0a0e",
    head: [255, 240, 210],
    tail: [255, 50, 80],
    lamp: [255, 190, 120],
    boat: "#f0e6e0",
    wake: "rgba(255,220,200,0.5)",
    gull: "#1a0f1a",
  },
  light: {
    sky: [
      [0, "#4f9fe0"],
      [0.45, "#8cc6ef"],
      [0.75, "#c8e4f4"],
      [0.92, "#fbe2c8"],
      [1, "#ffd9b0"],
    ],
    sun: [
      [255, 252, 235],
      [255, 236, 190],
    ],
    sunA: 0.95,
    glow: [255, 240, 210],
    cloud: [255, 255, 255],
    cloudA: 0.8,
    sea: ["#3fb4c8", "#1f8fb0", "#16769a"],
    shimmer: [255, 255, 245],
    sand: ["#f4dcb6", "#ead0a6"],
    walk: "#d7c2a3",
    road: "#5c5560",
    lane: "rgba(255,255,255,0.75)",
    hotel: ["#f6eee4", "#fbd9d6", "#d9f1ee"],
    window: [70, 120, 150],
    neon: ["#ff4fa3", "#16b7aa", "#ff9a3a"],
    palm: "#7a5a3a",
    frond: "#2f8a4a",
    rim: "rgba(255,255,255,0.0)",
    skin: "#c98d6a",
    cloth: ["#2d7fa8", "#ffffff", "#e0456f", "#2b2b33", "#f2b04a"],
    body: "#5a4a48",
    car: ["#22b8b3", "#118580"],
    chrome: "#f5f2ee",
    tyre: "#1e1c20",
    head: [255, 255, 240],
    tail: [230, 40, 70],
    lamp: [255, 220, 170],
    boat: "#ffffff",
    wake: "rgba(255,255,255,0.8)",
    gull: "#4a4f58",
  },
};

const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const lerp = (a, b, k) => a + (b - a) * k;
const ease = (k) => (k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k));
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
function sprite(c, a, soft = 0.4) {
  const { c: cv, g } = makeCanvas(96, 96, 1);
  const gr = g.createRadialGradient(48, 48, 0, 48, 48, 48);
  gr.addColorStop(0, rgba(c, a));
  gr.addColorStop(soft, rgba(c, a * 0.4));
  gr.addColorStop(1, rgba(c, 0));
  g.fillStyle = gr;
  g.fillRect(0, 0, 96, 96);
  return cv;
}

let ctx,
  W,
  H,
  PR,
  SCHEME,
  L,
  back,
  hotels,
  shore,
  spr = {};
let geo = {},
  palms = [],
  gulls = [],
  neons = [],
  lamps = [];
let now = 0,
  cheerAt = -Infinity;

/* ── People. Units: 1 = height, feet at y = 0, facing +x (mirrored by the caller). ─────────
   P: { hip:[near,far], knee:[..], arm:[near,far], elbow:[..], lean, hipH, headTilt, outfit }
   Angles are radians from straight down, positive toward the facing side. */

const at = (p, a, l) => [p[0] + Math.sin(a) * l, p[1] + Math.cos(a) * l];
const dk = (c) => shadeHex(c);

function person(g, x, y, s, facing, P) {
  // Units: 1 = height, feet at y = 0, facing +x (mirrored by facing). Light comes from screen-left.
  const O = P.outfit;
  const dark = SCHEME !== "light";
  const T = (p) => [x + facing * p[0] * s, y + p[1] * s];
  const hip = [0, -P.hipH];
  const up = [Math.sin(P.lean), -Math.cos(P.lean)];
  const neck = [hip[0] + up[0] * 0.33, hip[1] + up[1] * 0.33];
  const tilt = P.headTilt || 0;
  const head = [neck[0] + 0.01 + Math.sin(tilt) * 0.02, neck[1] - 0.08];
  const legs = [0, 1].map((i) => {
    if (P.feet) {
      // Explicit foot targets (the cyclist): two-bone IK, knee bending forward.
      const tgt = P.feet[i],
        a = 0.25,
        b = 0.24;
      const dx = tgt[0] - hip[0],
        dy = tgt[1] - hip[1];
      const d = Math.min(a + b - 1e-3, Math.hypot(dx, dy));
      const base = Math.atan2(dy, dx),
        ang = Math.acos((a * a + d * d - b * b) / (2 * a * d));
      const knee = [hip[0] + Math.cos(base - ang) * a, hip[1] + Math.sin(base - ang) * a];
      return { knee, ankle: tgt };
    }
    const knee = at(hip, P.hip[i], 0.25);
    return { knee, ankle: at(knee, P.hip[i] - P.knee[i], 0.24) };
  });
  const sh = [neck[0] - up[0] * 0.04, neck[1] - up[1] * 0.04];
  const arms = [0, 1].map((i) => {
    const s0 = [sh[0] + (i ? 0.012 : -0.008), sh[1]];
    const elbow = at(s0, P.arm[i], 0.155);
    return { s0, elbow, hand: at(elbow, P.arm[i] + P.elbow[i], 0.145) };
  });
  const lit = dark ? "rgba(255,165,140,0.22)" : "rgba(255,255,255,0.2)";
  const shd = dark ? "rgba(10,0,20,0.32)" : "rgba(0,0,0,0.18)";
  const strip = (A, B, wa, wb, col) => {
    const th = Math.atan2(B[1] - A[1], B[0] - A[0]);
    g.fillStyle = col;
    g.beginPath();
    g.arc(B[0], B[1], wb, th - Math.PI / 2, th + Math.PI / 2);
    g.arc(A[0], A[1], wa, th + Math.PI / 2, th + Math.PI * 1.5);
    g.closePath();
    g.fill();
  };
  // A limb with rounded shading: base, a lit edge toward screen-left, a shadowed edge away.
  const limb = (a, b, wa, wb, col) => {
    const A = T(a),
      B = T(b);
    strip(A, B, wa * s, wb * s, col);
    let nx = -(B[1] - A[1]),
      ny = B[0] - A[0];
    const l = Math.hypot(nx, ny) || 1;
    nx /= l;
    ny /= l;
    if (nx > 0) {
      nx = -nx;
      ny = -ny;
    }
    const o = (w) => w * s * 0.42;
    strip(
      [A[0] + nx * o(wa), A[1] + ny * o(wa)],
      [B[0] + nx * o(wb), B[1] + ny * o(wb)],
      wa * s * 0.45,
      wb * s * 0.45,
      lit,
    );
    strip(
      [A[0] - nx * o(wa), A[1] - ny * o(wa)],
      [B[0] - nx * o(wb), B[1] - ny * o(wb)],
      wa * s * 0.45,
      wb * s * 0.45,
      shd,
    );
  };
  const blob = (p, rx, ry, col, rot = 0) => {
    const q = T(p);
    g.fillStyle = col;
    g.beginPath();
    g.ellipse(q[0], q[1], rx * s, ry * s, rot, 0, Math.PI * 2);
    g.fill();
  };
  const path = (pts) => {
    g.beginPath();
    pts.forEach((p, i) => {
      if (p.length === 4) {
        const c = T([p[0], p[1]]),
          e = T([p[2], p[3]]);
        g.quadraticCurveTo(c[0], c[1], e[0], e[1]);
      } else {
        const q = T(p);
        if (i) g.lineTo(q[0], q[1]);
        else g.moveTo(q[0], q[1]);
      }
    });
    g.closePath();
  };
  const fillShaded = (col) => {
    g.fillStyle = col;
    g.fill();
    const bb = T([0, 0]);
    const gr = g.createLinearGradient(bb[0] - s * 0.12, 0, bb[0] + s * 0.12, 0);
    gr.addColorStop(0, lit);
    gr.addColorStop(0.5, "rgba(0,0,0,0)");
    gr.addColorStop(1, shd);
    g.fillStyle = gr;
    g.fill();
  };
  const tq = (u, v) => [
    hip[0] + Math.cos(P.lean) * u + up[0] * v,
    hip[1] + Math.sin(P.lean) * u + up[1] * v,
  ];
  const legCol = (i, part) => {
    const c =
      O.bottomStyle === "pants" || (O.bottomStyle === "shorts" && part === "thigh")
        ? O.bottom
        : O.skin;
    return i ? dk(c) : c;
  };
  const leg = (i) => {
    const l = legs[i];
    limb(hip, l.knee, 0.054, 0.04, legCol(i, "thigh"));
    // Calf: fuller just below the knee.
    limb(
      l.knee,
      [lerp(l.knee[0], l.ankle[0], 0.35), lerp(l.knee[1], l.ankle[1], 0.35)],
      0.04,
      0.042,
      legCol(i, "shin"),
    );
    limb(
      [lerp(l.knee[0], l.ankle[0], 0.35), lerp(l.knee[1], l.ankle[1], 0.35)],
      l.ankle,
      0.042,
      0.026,
      legCol(i, "shin"),
    );
    if (O.bottomStyle === "shorts")
      limb(
        hip,
        at(hip, Math.atan2(l.knee[0] - hip[0], l.knee[1] - hip[1]), 0.15),
        0.059,
        0.052,
        i ? dk(O.bottom) : O.bottom,
      );
    const sc = i ? dk(O.shoes) : O.shoes;
    path([
      [l.ankle[0] - 0.032, l.ankle[1] - 0.014],
      [l.ankle[0] + 0.045, l.ankle[1] - 0.01],
      [l.ankle[0] + 0.078, l.ankle[1] + 0.006],
      [l.ankle[0] + 0.076, l.ankle[1] + 0.022],
      [l.ankle[0] - 0.036, l.ankle[1] + 0.022],
    ]);
    g.fillStyle = sc;
    g.fill();
  };
  const arm = (i) => {
    const a = arms[i],
      d = i === 1,
      sk = d ? dk(O.skin) : O.skin;
    limb(a.s0, a.elbow, 0.031, 0.025, sk);
    limb(a.elbow, a.hand, 0.026, 0.019, sk);
    if (O.topStyle === "tee")
      limb(a.s0, at(a.s0, P.arm[i], 0.075), 0.042, 0.035, d ? dk(O.top) : O.top);
    blob(a.hand, 0.021, 0.025, sk);
  };

  // Far leg and arm first.
  leg(1);
  arm(1);
  if (O.hairStyle === "long") {
    path([
      [head[0] - 0.052, head[1] - 0.02],
      [head[0] + 0.0, head[1] - 0.04],
      [head[0] - 0.01, head[1] + 0.06, head[0] - 0.004, head[1] + 0.14],
      [head[0] - 0.07, head[1] + 0.13],
    ]);
    g.fillStyle = O.hair;
    g.fill();
  }
  // Torso: rounded shoulders, chest, a narrower waist, hips.
  const garment = O.bottomStyle === "dress" ? O.bottom : O.top;
  path([
    tq(-0.07, 0.0),
    tq(0.072, 0.0),
    tq(0.075, 0.1),
    [...tq(0.095, 0.22), ...tq(0.092, 0.28)],
    tq(0.06, 0.315),
    tq(-0.06, 0.315),
    [...tq(-0.092, 0.28), ...tq(-0.09, 0.2)],
    tq(-0.072, 0.1),
  ]);
  fillShaded(garment);
  if (O.topStyle === "tank") {
    path([tq(-0.035, 0.27), tq(0.035, 0.27), tq(0.025, 0.315), tq(-0.025, 0.315)]);
    g.fillStyle = O.skin;
    g.fill();
  }
  if (O.bottomStyle === "skirt" || O.bottomStyle === "dress") {
    const sway = P.sway || 0;
    path([tq(-0.078, 0.03), tq(0.078, 0.03), tq(0.125 + sway, -0.21), tq(-0.115 + sway, -0.21)]);
    fillShaded(O.bottom);
  } else {
    path([tq(-0.077, -0.06), tq(0.077, -0.06), tq(0.079, 0.04), tq(-0.079, 0.04)]);
    fillShaded(O.bottom);
    path([tq(-0.079, 0.028), tq(0.079, 0.028), tq(0.079, 0.042), tq(-0.079, 0.042)]);
    g.fillStyle = dk(O.bottom);
    g.fill();
  }
  leg(0);
  // Neck, then the head in profile: skull, brow, nose, lips, chin, jaw.
  limb([neck[0], neck[1] + 0.012], [head[0], head[1] + 0.045], 0.021, 0.019, O.skin);
  const h = head;
  g.save();
  const hc = T(h);
  g.translate(hc[0], hc[1]);
  g.rotate(tilt * facing);
  g.translate(-hc[0], -hc[1]);
  blob([h[0] - 0.004, h[1]], 0.047, 0.052, O.skin);
  path([
    [h[0] + 0.02, h[1] - 0.045],
    [h[0] + 0.048, h[1] - 0.018],
    [h[0] + 0.05, h[1] - 0.004],
    [h[0] + 0.064, h[1] + 0.014],
    [h[0] + 0.052, h[1] + 0.02],
    [h[0] + 0.055, h[1] + 0.03],
    [h[0] + 0.05, h[1] + 0.036],
    [h[0] + 0.046, h[1] + 0.052],
    [h[0] + 0.012, h[1] + 0.058],
    [h[0] - 0.01, h[1] + 0.03],
  ]);
  g.fillStyle = O.skin;
  g.fill();
  blob([h[0] - 0.008, h[1] + 0.008], 0.011, 0.016, dk(O.skin)); // ear
  const hs = O.hairStyle;
  if (hs === "cap") {
    path([
      [h[0] - 0.05, h[1] - 0.004],
      [h[0] - 0.052, h[1] - 0.05, h[0] + 0.005, h[1] - 0.058],
      [h[0] + 0.045, h[1] - 0.05, h[0] + 0.05, h[1] - 0.02],
      [h[0] + 0.1, h[1] - 0.012],
      [h[0] + 0.098, h[1] - 0.002],
      [h[0] + 0.02, h[1] - 0.01],
    ]);
    g.fillStyle = O.cap;
    g.fill();
  } else {
    const tall = hs === "short" ? 0.03 : 0.038;
    path([
      [h[0] - 0.055, h[1] + 0.012],
      [h[0] - 0.056, h[1] - 0.052, h[0] + 0.0, h[1] - 0.058 - tall * 0.3],
      [h[0] + 0.04, h[1] - 0.056, h[0] + 0.05, h[1] - 0.024],
      [h[0] + 0.022, h[1] - 0.03],
      [h[0] - 0.01, h[1] - 0.02],
      [h[0] - 0.02, h[1] + 0.02],
    ]);
    g.fillStyle = O.hair;
    g.fill();
    if (hs === "bun") blob([h[0] - 0.05, h[1] - 0.04], 0.026, 0.026, O.hair);
    // Hair sheen.
    path([
      [h[0] - 0.03, h[1] - 0.045],
      [h[0] + 0.0, h[1] - 0.056],
      [h[0] + 0.02, h[1] - 0.05],
      [h[0] - 0.01, h[1] - 0.042],
    ]);
    g.fillStyle = dark ? "rgba(255,170,150,0.25)" : "rgba(255,255,255,0.25)";
    g.fill();
  }
  if (O.shades) {
    path([
      [h[0] + 0.018, h[1] - 0.006],
      [h[0] + 0.056, h[1] - 0.004],
      [h[0] + 0.054, h[1] + 0.012],
      [h[0] + 0.022, h[1] + 0.012],
    ]);
    g.fillStyle = "#0c0c10";
    g.fill();
  } else {
    blob([h[0] + 0.036, h[1] - 0.001], 0.006, 0.005, "#141016"); // eye
  }
  g.restore();
  arm(0);
  if (O.phone) {
    const hn = arms[0].hand;
    path([
      [hn[0] - 0.012, hn[1] - 0.042],
      [hn[0] + 0.012, hn[1] - 0.042],
      [hn[0] + 0.012, hn[1] + 0.004],
      [hn[0] - 0.012, hn[1] + 0.004],
    ]);
    g.fillStyle = "#101014";
    g.fill();
  }
  return { hand0: arms[0].hand, hand1: arms[1].hand, head };
}

const SKINS = ["#f1c7a4", "#d9a07a", "#b97a52", "#8a5a3a", "#5e3b28"];

const walkLeg = (q) => ({
  h: 0.04 + 0.32 * Math.sin(q),
  k: 0.08 + 0.68 * Math.pow(Math.max(0, Math.cos(q)), 1.5),
});
function walkPose(p, outfit, extra = {}) {
  const a = walkLeg(p),
    b = walkLeg(p + Math.PI);
  return Object.assign(
    {
      hip: [a.h, b.h],
      knee: [a.k, b.k],
      arm: [-0.3 * Math.sin(p), 0.3 * Math.sin(p)],
      elbow: [0.22, 0.22],
      lean: 0.03,
      hipH: 0.5 + 0.01 * Math.cos(p * 2),
      outfit,
      sway: Math.sin(p) * 0.02,
    },
    extra,
  );
}
const jogLeg = (q) => ({
  h: 0.12 + 0.5 * Math.sin(q),
  k: 0.25 + 1.0 * Math.pow(Math.max(0, Math.cos(q)), 1.4),
});
function jogPose(p, outfit) {
  const a = jogLeg(p),
    b = jogLeg(p + Math.PI);
  return {
    hip: [a.h, b.h],
    knee: [a.k, b.k],
    arm: [-0.55 * Math.sin(p), 0.55 * Math.sin(p)],
    elbow: [1.3, 1.3],
    lean: 0.12,
    hipH: 0.49 + 0.025 * Math.pow(Math.sin(p), 2),
    outfit,
  };
}
function standPose(outfit, t, seed, extra = {}) {
  const b = Math.sin(t * 0.0013 + seed) * 0.004;
  return Object.assign(
    {
      hip: [0.06, -0.06],
      knee: [0.04, 0.06],
      arm: [0.08, -0.06],
      elbow: [0.12, 0.1],
      lean: 0.01,
      hipH: 0.5 + b,
      outfit,
      headTilt: 0,
    },
    extra,
  );
}

/* ── Build ─────────────────────────────────────────────────────────────────────────────── */

const outfitOf = (top, topStyle, bottom, bottomStyle, hairStyle, hair, skin, extra = {}) =>
  Object.assign(
    {
      top,
      topStyle,
      bottom,
      bottomStyle,
      hairStyle,
      hair,
      skin: SKINS[skin],
      shoes: "#f2efe8",
      cap: "#f2b04a",
      shades: false,
      phone: false,
    },
    extra,
  );
const mixc = (a, b, k2) => [0, 1, 2].map((j) => Math.round(a[j] + (b[j] - a[j]) * k2));

function build(view) {
  W = view.width;
  H = view.height;
  PR = view.pixelRatio;
  SCHEME = view.scheme;
  const dark = SCHEME !== "light";
  L = LOOK[dark ? "dark" : "light"];
  const rnd = seeded(1986);
  const horizon = H * 0.57,
    beach = H * 0.67,
    walk = H * 0.735,
    road = H * 0.8,
    curb = H * 0.985;
  // Everything on the shore is sized from a person's height: lamps ~4.6x, palms 6-8x, cars ~2.6x long.
  const P1 = Math.max(44, Math.min(95, H * 0.08));
  geo = { horizon, beach, walk, road, curb, sunX: W * 0.42, sunR: Math.min(W, H) * 0.11, s: P1 };

  /* Sky: gradient, haze at the horizon, volumetric clouds lit from below, the sun with bloom and rays. */
  const B = makeCanvas(W, H, PR);
  back = B.c;
  const g = B.g;
  const sky = g.createLinearGradient(0, 0, 0, horizon);
  L.sky.forEach(([t, c]) => sky.addColorStop(t, c));
  g.fillStyle = sky;
  g.fillRect(0, 0, W, horizon + 1);
  const sunY = horizon - geo.sunR * (dark ? 0.35 : 2.8);
  geo.sunY = sunY;
  const glow = g.createRadialGradient(geo.sunX, sunY, 0, geo.sunX, sunY, Math.max(W, H) * 0.75);
  glow.addColorStop(0, rgba(L.glow, dark ? 0.6 : 0.45));
  glow.addColorStop(0.25, rgba(L.glow, 0.2));
  glow.addColorStop(1, rgba(L.glow, 0));
  g.fillStyle = glow;
  g.fillRect(0, 0, W, horizon);
  // Clouds: banks of soft puffs; tops take the sky's cool colour, bellies the sun's warm light.
  const cloudTop = dark ? [86, 40, 96] : [236, 242, 250];
  const cloudBelly = dark ? [255, 150, 130] : [255, 250, 240];
  const shadowCol = dark ? [60, 26, 70] : [190, 205, 222];
  for (let bank = 0; bank < 5; bank++) {
    const by = H * (0.1 + bank * 0.085) + rnd() * H * 0.03;
    let bx = -W * 0.1 + rnd() * W * 0.2;
    while (bx < W * 1.1) {
      const w = W * (0.08 + rnd() * 0.16),
        h = H * (0.025 + rnd() * 0.03) * (1 - bank * 0.12);
      if (rnd() < 0.55) {
        for (let i = 0; i < 8; i++) {
          const px = bx + rnd() * w,
            py = by - rnd() * h * 0.6,
            r = h * (0.6 + rnd() * 0.8);
          const near = 1 - Math.min(1, Math.abs(px - geo.sunX) / (W * 0.6));
          const top = mixc(shadowCol, cloudTop, 0.6),
            belly = mixc(cloudTop, cloudBelly, 0.4 + near * 0.6);
          // A soft streak: a round gradient stretched sideways, so no edge is ever clipped.
          g.save();
          g.translate(px, py);
          g.scale(4.2, 0.6);
          const cg = g.createRadialGradient(0, r * 0.3, 0, 0, 0, r);
          cg.addColorStop(0, rgba(belly, dark ? 0.42 : 0.7));
          cg.addColorStop(0.55, rgba(top, dark ? 0.22 : 0.4));
          cg.addColorStop(1, rgba(top, 0));
          g.fillStyle = cg;
          g.fillRect(-r, -r, r * 2, r * 2);
          g.restore();
        }
      }
      bx += w * (0.8 + rnd() * 0.8);
    }
  }
  const haze = g.createLinearGradient(0, horizon - H * 0.12, 0, horizon);
  haze.addColorStop(0, rgba(L.glow, 0));
  haze.addColorStop(1, rgba(L.glow, dark ? 0.35 : 0.5));
  g.fillStyle = haze;
  g.fillRect(0, horizon - H * 0.12, W, H * 0.12);
  g.save();
  g.beginPath();
  g.rect(0, 0, W, horizon);
  g.clip();
  const sg = g.createLinearGradient(0, sunY - geo.sunR, 0, sunY + geo.sunR);
  sg.addColorStop(0, rgba(L.sun[0], L.sunA));
  sg.addColorStop(1, rgba(L.sun[1], L.sunA));
  g.fillStyle = sg;
  g.beginPath();
  g.arc(geo.sunX, sunY, geo.sunR, 0, Math.PI * 2);
  g.fill();
  g.globalCompositeOperation = "lighter";
  const bloom = g.createRadialGradient(
    geo.sunX,
    sunY,
    geo.sunR * 0.8,
    geo.sunX,
    sunY,
    geo.sunR * 3,
  );
  bloom.addColorStop(0, rgba(L.sun[0], 0.35));
  bloom.addColorStop(1, rgba(L.sun[0], 0));
  g.fillStyle = bloom;
  g.fillRect(geo.sunX - geo.sunR * 3, sunY - geo.sunR * 3, geo.sunR * 6, geo.sunR * 6);
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i - 4.5) * 0.24 + (rnd() - 0.5) * 0.08,
      len = H * (0.5 + rnd() * 0.3),
      w = 0.025 + rnd() * 0.03;
    const rg = g.createLinearGradient(
      geo.sunX,
      sunY,
      geo.sunX + Math.cos(a) * len,
      sunY + Math.sin(a) * len,
    );
    rg.addColorStop(0, rgba(L.sun[0], dark ? 0.08 : 0.06));
    rg.addColorStop(1, rgba(L.sun[0], 0));
    g.fillStyle = rg;
    g.beginPath();
    g.moveTo(geo.sunX, sunY);
    g.lineTo(geo.sunX + Math.cos(a - w) * len, sunY + Math.sin(a - w) * len);
    g.lineTo(geo.sunX + Math.cos(a + w) * len, sunY + Math.sin(a + w) * len);
    g.closePath();
    g.fill();
  }
  g.globalCompositeOperation = "source-over";
  g.restore();

  /* Sea: deepening with distance, waves shrinking toward the horizon, the sun's path. */
  const sea = g.createLinearGradient(0, horizon, 0, beach);
  sea.addColorStop(0, L.sea[0]);
  sea.addColorStop(0.4, L.sea[1]);
  sea.addColorStop(1, L.sea[2]);
  g.fillStyle = sea;
  g.fillRect(0, horizon, W, beach - horizon);
  for (let y = horizon + 1, step = 1.2; y < beach; y += step, step *= 1.07) {
    const depth = (y - horizon) / (beach - horizon);
    for (let x = rnd() * 40; x < W; x += 20 + rnd() * 60) {
      const len = (6 + rnd() * 30) * (0.4 + depth);
      g.fillStyle =
        rnd() < 0.5
          ? dark
            ? "rgba(0,0,0,0.16)"
            : "rgba(0,40,70,0.12)"
          : rgba(L.shimmer, dark ? 0.07 : 0.18);
      g.fillRect(x, y, len, Math.max(0.8, depth * 2.2));
    }
  }
  const path = g.createLinearGradient(geo.sunX - geo.sunR * 1.8, 0, geo.sunX + geo.sunR * 1.8, 0);
  path.addColorStop(0, rgba(L.shimmer, 0));
  path.addColorStop(0.5, rgba(L.shimmer, dark ? 0.3 : 0.22));
  path.addColorStop(1, rgba(L.shimmer, 0));
  g.fillStyle = path;
  g.fillRect(geo.sunX - geo.sunR * 1.8, horizon, geo.sunR * 3.6, beach - horizon);

  /* Hotels: lit fronts, shaded sides, balconies, glass reflecting the sky, rooftop signs. */
  const Hc = makeCanvas(W, H, PR);
  hotels = Hc.c;
  const h = Hc.g;
  neons = [];
  const names = ["PALMS", "HOTEL", "OCEAN", "CASA", "SUNSET", "MARINA"];
  let x = W * 0.6,
    k = 0;
  while (x < W + 20) {
    const w = W * (0.07 + rnd() * 0.06);
    const ht = H * (0.12 + rnd() * 0.16) * (k === 2 ? 1.55 : 1);
    const top = beach - ht,
      side = w * 0.18;
    const col = L.hotel[k % L.hotel.length];
    // Side face (in shadow), then the front with a warm-to-cool vertical light.
    h.fillStyle = dark ? "rgba(10,4,14,0.9)" : "rgba(120,110,120,0.45)";
    h.beginPath();
    h.moveTo(x + w, top + w * 0.1);
    h.lineTo(x + w + side, top + w * 0.16);
    h.lineTo(x + w + side, beach + 4);
    h.lineTo(x + w, beach + 4);
    h.closePath();
    h.fill();
    h.fillStyle = col;
    h.beginPath();
    h.roundRect(x, top, w, ht + 4, [w * 0.18, w * 0.18, 0, 0]);
    h.fill();
    const lit = h.createLinearGradient(x, top, x, beach);
    lit.addColorStop(0, dark ? "rgba(255,120,140,0.12)" : "rgba(255,255,255,0.25)");
    lit.addColorStop(1, dark ? "rgba(0,0,0,0.25)" : "rgba(255,200,170,0.18)");
    h.fillStyle = lit;
    h.fillRect(x, top, w, ht + 4);
    h.fillStyle = col;
    h.fillRect(x + w * 0.42, top - H * 0.03, w * 0.16, H * 0.03); // deco fin
    // Floors: balcony ledges with a lit lip, glass between.
    for (let wy = top + 16; wy < beach - 8; wy += 12) {
      const glass = h.createLinearGradient(0, wy, 0, wy + 8);
      glass.addColorStop(0, dark ? "rgba(255,140,120,0.22)" : "rgba(120,190,230,0.45)");
      glass.addColorStop(1, dark ? "rgba(30,10,40,0.5)" : "rgba(60,110,150,0.4)");
      h.fillStyle = glass;
      h.fillRect(x + 5, wy, w - 10, 8);
      for (let wx = x + 6; wx < x + w - 10; wx += 9)
        if (rnd() < (dark ? 0.35 : 0.15)) {
          h.fillStyle = rgba(L.window, dark ? 0.6 + rnd() * 0.3 : 0.25);
          h.fillRect(wx, wy + 1, 5, 6);
        }
      h.fillStyle = dark ? "rgba(255,170,150,0.18)" : "rgba(255,255,255,0.7)";
      h.fillRect(x + 3, wy + 8, w - 6, 1.5);
      h.fillStyle = dark ? "rgba(0,0,0,0.3)" : "rgba(0,0,0,0.08)";
      h.fillRect(x + 3, wy + 9.5, w - 6, 1.5);
    }
    neons.push({
      x: x + w / 2,
      y: top - H * 0.04,
      w,
      text: names[k % names.length],
      col: L.neon[k % 3],
      p: rnd() * 6,
    });
    x += w + side + W * 0.008;
    k++;
  }

  /* Shore: sand with grain and a wet band, boardwalk planks, textured asphalt, curb. */
  const S = makeCanvas(W, H, PR);
  shore = S.c;
  const s2 = S.g;
  const sand = s2.createLinearGradient(0, beach, 0, walk);
  sand.addColorStop(0, L.sand[0]);
  sand.addColorStop(1, L.sand[1]);
  s2.fillStyle = sand;
  s2.fillRect(0, beach, W, walk - beach);
  const wet = s2.createLinearGradient(0, beach, 0, beach + (walk - beach) * 0.35);
  wet.addColorStop(0, dark ? "rgba(40,20,50,0.6)" : "rgba(150,120,90,0.35)");
  wet.addColorStop(1, "rgba(0,0,0,0)");
  s2.fillStyle = wet;
  s2.fillRect(0, beach, W, (walk - beach) * 0.35);
  for (let i = 0; i < W * 1.5; i++) {
    s2.fillStyle = rnd() < 0.5 ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.08)";
    s2.fillRect(rnd() * W, beach + rnd() * (walk - beach), 1, 1);
  }
  s2.fillStyle = L.walk;
  s2.fillRect(0, walk, W, road - walk);
  for (let bx = 0; bx < W; bx += 24) {
    s2.fillStyle = dark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.07)";
    s2.fillRect(bx, walk, 1, road - walk);
  }
  s2.fillStyle = dark ? "rgba(255,180,160,0.12)" : "rgba(255,255,255,0.5)";
  s2.fillRect(0, walk, W, 1.5);
  s2.fillStyle = L.road;
  s2.fillRect(0, road, W, curb - road);
  for (let i = 0; i < W * 2; i++) {
    s2.fillStyle = rnd() < 0.5 ? "rgba(0,0,0,0.12)" : "rgba(255,255,255,0.05)";
    s2.fillRect(rnd() * W, road + rnd() * (curb - road), 1.5, 1);
  }
  s2.fillStyle = L.lane;
  const laneY = (road + curb) / 2;
  for (let lx = 0; lx < W; lx += 60) s2.fillRect(lx, laneY, 30, 2);
  s2.fillStyle = dark ? "rgba(0,0,0,0.35)" : "rgba(0,0,0,0.12)";
  s2.fillRect(0, road, W, 3);
  s2.fillStyle = L.walk;
  s2.fillRect(0, curb, W, H - curb);
  s2.fillStyle = dark ? "rgba(255,180,160,0.15)" : "rgba(255,255,255,0.6)";
  s2.fillRect(0, curb, W, 1.5);
  lamps = [];
  for (let lx = W * 0.08; lx < W; lx += W * 0.22) {
    if (dark) {
      const pool = s2.createRadialGradient(
        lx + P1 * 0.5,
        road - 4,
        0,
        lx + P1 * 0.5,
        road - 4,
        P1 * 2.2,
      );
      pool.addColorStop(0, rgba(L.lamp, 0.28));
      pool.addColorStop(1, rgba(L.lamp, 0));
      s2.fillStyle = pool;
      s2.beginPath();
      s2.ellipse(lx + P1 * 0.5, road - 4, P1 * 2.4, P1 * 0.5, 0, 0, Math.PI * 2);
      s2.fill();
    }
    const lh = P1 * 4.6,
      arm = P1 * 0.55;
    s2.fillStyle = L.palm;
    s2.fillRect(lx, walk + (road - walk) * 0.6 - lh, Math.max(3, P1 * 0.05), lh);
    s2.fillRect(lx, walk + (road - walk) * 0.6 - lh, arm, Math.max(2.5, P1 * 0.04));
    s2.fillRect(lx + arm - P1 * 0.12, walk + (road - walk) * 0.6 - lh, P1 * 0.16, P1 * 0.06);
    lamps.push({ x: lx + arm - P1 * 0.04, y: walk + (road - walk) * 0.6 - lh + P1 * 0.07 });
  }

  /* Palms: ringed, shaded trunks (static); fronds sway each frame. */
  palms = [];
  for (const f of [0.03, 0.17, 0.3, 0.52, 0.66, 0.79, 0.93]) {
    const px = W * f + (rnd() - 0.5) * 30;
    const ph = P1 * (6 + rnd() * 2.2);
    const lean = (rnd() - 0.5) * 0.4;
    const base = [px, walk - 4 + rnd() * 6];
    const top = [px + Math.sin(lean) * ph, base[1] - Math.cos(lean) * ph];
    const ctrl = [px + Math.sin(lean) * ph * 0.2 + (rnd() - 0.5) * 30, base[1] - ph * 0.5];
    const qx = (t) => (1 - t) * (1 - t) * base[0] + 2 * (1 - t) * t * ctrl[0] + t * t * top[0];
    const qy = (t) => (1 - t) * (1 - t) * base[1] + 2 * (1 - t) * t * ctrl[1] + t * t * top[1];
    s2.lineCap = "round";
    for (let i = 0; i < 40; i++) {
      const t0 = i / 40,
        t1 = (i + 1) / 40,
        wdt = lerp(P1 * 0.16, P1 * 0.07, t0);
      s2.strokeStyle = L.palm;
      s2.lineWidth = wdt;
      s2.beginPath();
      s2.moveTo(qx(t0), qy(t0));
      s2.lineTo(qx(t1), qy(t1));
      s2.stroke();
      // Lit edge toward the sun, and a ring every few segments.
      s2.strokeStyle = dark ? "rgba(255,140,120,0.35)" : "rgba(255,230,190,0.45)";
      s2.lineWidth = wdt * 0.25;
      const off = qx(t0) < geo.sunX ? wdt * 0.32 : -wdt * 0.32;
      s2.beginPath();
      s2.moveTo(qx(t0) + off, qy(t0));
      s2.lineTo(qx(t1) + off, qy(t1));
      s2.stroke();
      if (i % 2 === 0) {
        s2.strokeStyle = dark ? "rgba(0,0,0,0.45)" : "rgba(60,40,20,0.35)";
        s2.lineWidth = 1;
        s2.beginPath();
        s2.moveTo(qx(t0) - wdt / 2, qy(t0));
        s2.lineTo(qx(t0) + wdt / 2, qy(t0) - 1);
        s2.stroke();
      }
    }
    palms.push({ x: top[0], y: top[1], len: P1 * (1.6 + rnd() * 0.5), p: rnd() * 6, n: 11 });
  }

  /* Palm crowns as sprites, swayed whole each frame. */
  for (const pm of palms) {
    const w = pm.len * 2.9,
      hgt = pm.len * 2.0,
      ox = w / 2,
      oy = pm.len * 0.62;
    const C = makeCanvas(w, hgt, PR);
    const saved = ctx,
      sx = pm.x,
      sy = pm.y;
    ctx = C.g;
    pm.x = ox;
    pm.y = oy;
    crown(pm);
    ctx = saved;
    pm.x = sx;
    pm.y = sy;
    Object.assign(pm, { sprite: C.c, sw: w, sh: hgt, ox, oy });
  }

  /* Grain and vignette. */
  const V = makeCanvas(W, H, PR);
  geo.vignette = V.c;
  const vg = V.g.createRadialGradient(
    W * 0.5,
    H * 0.55,
    Math.min(W, H) * 0.35,
    W * 0.5,
    H * 0.55,
    Math.max(W, H) * 0.8,
  );
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, dark ? "rgba(10,0,20,0.5)" : "rgba(60,40,30,0.18)");
  V.g.fillStyle = vg;
  V.g.fillRect(0, 0, W, H);
  // One static picture: sky and sea, hotels, shore, vignette. One full-window copy per frame.
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.drawImage(hotels, 0, 0);
  g.drawImage(shore, 0, 0);
  g.drawImage(V.c, 0, 0);
  g.setTransform(PR, 0, 0, PR, 0, 0);

  spr = {
    lamp: sprite(L.lamp, 0.9),
    head: sprite(L.head, 0.9),
    tail: sprite(L.tail, 0.9),
    neon: L.neon.map((c) => sprite(hexrgb(c), 0.8)),
  };
  gulls = Array.from({ length: 7 }, () => ({
    x: rnd(),
    y: 0.12 + rnd() * 0.3,
    v: 0.000012 + rnd() * 0.00001,
    p: rnd() * 6,
    s: 0.7 + rnd() * 0.6,
  }));
  const C = outfitOf;
  geo.out = {
    stroller: C("#f4f2ec", "tee", "#2d6f9f", "shorts", "short", "#2a1a14", 2, { shades: true }),
    skater: C("#e0456f", "tank", "#26262e", "shorts", "cap", "#2a1a14", 1, {
      cap: "#f2b04a",
      shoes: "#18181c",
    }),
    her: C("#ff6f61", "tank", "#ff6f61", "dress", "long", "#2a1610", 3, {
      shades: true,
      shoes: "#d8b48a",
    }),
    him: C("#26365c", "tee", "#d8c8a8", "pants", "short", "#1a1210", 0, { shoes: "#5a4030" }),
    jogger: C("#b6e34a", "tank", "#18181c", "shorts", "cap", "#1a1210", 4, {
      cap: "#f4f4f4",
      shoes: "#ff5a3c",
    }),
    selfie: C("#ffd23f", "tank", "#f8f6f0", "skirt", "bun", "#3a2418", 1, {
      phone: true,
      shoes: "#f4e8d8",
    }),
    waver: C("#16a3a0", "tee", "#c8b48a", "shorts", "short", "#120c0a", 3, { shades: true }),
    chatA: C("#ffffff", "tee", "#3a5a8a", "pants", "short", "#3a2418", 0),
    chatB: C("#c04a8a", "tank", "#1c1c24", "skirt", "long", "#120c0a", 2, { shades: true }),
    chatC: C("#f2b04a", "tee", "#5a6a5a", "shorts", "cap", "#2a1a14", 4, { cap: "#1c1c24" }),
    dogger: C("#9aa4ae", "tee", "#2a2a32", "pants", "long", "#c08a50", 0, { shoes: "#ffffff" }),
    shore1: C("#ffffff", "tee", "#3a6a9a", "shorts", "short", "#2a1a14", 2),
    shore2: C("#ff9ab0", "tank", "#ff9ab0", "dress", "long", "#3a2418", 1),
    musician: C("#2b2b33", "tee", "#3a3a48", "pants", "long", "#1a1210", 2, { shoes: "#5a4030" }),
    cyclist: C("#ff5a3c", "tee", "#1c1c24", "shorts", "cap", "#1a1210", 3, { cap: "#f4f4f4" }),
    fighterA: C("#ffffff", "tank", "#2a3a5a", "shorts", "short", "#120c0a", 4),
    fighterB: C("#d9446e", "tee", "#3a3a3a", "pants", "cap", "#1a1210", 1, { cap: "#16a3a0" }),
    peacemaker: C("#f2b04a", "tee", "#5a6a5a", "pants", "short", "#3a2418", 0),
    filmer: C("#9aa4ae", "tank", "#1c1c24", "skirt", "long", "#2a1610", 2, { phone: true }),
    pointer: C("#3a6a9a", "tee", "#d8c8a8", "shorts", "short", "#2a1a14", 3),
  };
  const N = 20;
  geo.figs = Array.from({ length: N }, () => {
    const F = makeCanvas(P1 * 1.5, P1 * 1.35, PR);
    F.rim = makeCanvas(P1 * 1.5, P1 * 1.35, PR).c;
    return F;
  });
  geo.rows = {
    back: walk + (road - walk) * 0.3,
    front: walk + (road - walk) * 0.82,
    shore: beach + (walk - beach) * 0.25,
  };
  geo.carCache = new Map();
  geo.rimCache = new Map();
  geo.beamSpr = null;
  makeTraffic();
  geo.lastT = null;
  // Paint every model, colour and direction now, so no car is painted mid-animation.
  for (const ln of geo.lanes) {
    for (const [type, , paints] of FLEET)
      for (const pt of paints) carSprite(type, pt, ln.len, ln.dir);
    carSprite("police", ["#f4f4f6", "#16161c"], ln.len, ln.dir);
    for (const type of Object.keys(BODIES)) rimSprite(type, BODIES[type].r * (ln.len / 100));
  }
}

function hexrgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function shadeHex(h) {
  const [r, g, b] = hexrgb(h);
  return `rgb(${(r * 0.72) | 0},${(g * 0.72) | 0},${(b * 0.72) | 0})`;
}

/* ── Moving things ─────────────────────────────────────────────────────────────────────── */

function crown(p) {
  // Each frond arcs up from the crown and droops, with leaflets hanging off it. Painted once.
  const t = 0,
    still = true;
  {
    for (let i = 0; i < p.n; i++) {
      const spread = (i / (p.n - 1)) * 2 - 1; // -1 .. 1 across the fan
      const sway = still
        ? 0
        : Math.sin(t * 0.0011 + p.p + i * 0.7) * 0.07 + Math.sin(t * 0.0004 + p.p) * 0.05;
      const dir = spread * 1.25 + sway; // radians from straight up
      const len = p.len * (1 - Math.abs(spread) * 0.12) * (0.95 + 0.1 * Math.sin(i * 2.3));
      const ex = p.x + Math.sin(dir) * len * 1.05;
      const ey = p.y - Math.cos(dir) * len * 0.25 + len * (0.35 + Math.abs(spread) * 0.45);
      const cx = p.x + Math.sin(dir) * len * 0.55;
      const cy = p.y - len * (0.42 - Math.abs(spread) * 0.12);
      const Q = (k) => [
        (1 - k) * (1 - k) * p.x + 2 * (1 - k) * k * cx + k * k * ex,
        (1 - k) * (1 - k) * p.y + 2 * (1 - k) * k * cy + k * k * ey,
      ];
      // Leaflets: long at the base of the frond, short at the tip, hanging down.
      ctx.strokeStyle = L.frond;
      ctx.lineCap = "round";
      ctx.lineWidth = Math.max(1.2, len * 0.022);
      ctx.beginPath();
      for (let k = 0.12; k < 0.98; k += 0.055) {
        const [qx, qy] = Q(k);
        const l = len * 0.32 * (1 - k * 0.75);
        const hang = 0.9 + k * 0.5;
        ctx.moveTo(qx, qy);
        ctx.lineTo(qx + Math.sin(dir) * l * 0.35 + l * 0.25, qy + l * hang * 0.75);
        ctx.moveTo(qx, qy);
        ctx.lineTo(qx + Math.sin(dir) * l * 0.35 - l * 0.25, qy + l * hang * 0.75);
      }
      ctx.stroke();
      // The rib.
      ctx.lineWidth = Math.max(2, len * 0.04);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.quadraticCurveTo(cx, cy, ex, ey);
      ctx.stroke();
    }
    ctx.fillStyle = L.palm;
    ctx.beginPath();
    ctx.arc(p.x, p.y + p.len * 0.03, p.len * 0.08, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Draw a person into their own canvas, light it, give them a rim and a ground shadow. */
function drawPerson(i, x, y, s, facing, P, every = 0) {
  // Standing figures refresh every 3-4 frames, walkers every 2, the fight and the cyclist every frame.
  every =
    every ||
    {
      11: 6,
      12: 6,
      5: 5,
      9: 4,
      7: 3,
      8: 4,
      6: 3,
      13: 3,
      18: 5,
      19: 5,
      10: 2,
      3: 2,
      2: 2,
      4: 2,
      0: 2,
      1: 2,
      17: 2,
      14: 2,
    }[i] ||
    1;
  // Re-render the figure only every `every` frames (staggered by index); in between, reuse it.
  const F = geo.figs[i];
  const fg = F.g,
    cw = F.c.width,
    ch = F.c.height;
  const fresh = !F.parts || F.s !== s || F.facing !== facing || (geo.frameNo + i) % every === 0;
  if (!fresh) return placePerson(F, i, x, y, s, facing);
  F.s = s;
  F.facing = facing;
  fg.setTransform(1, 0, 0, 1, 0, 0);
  fg.globalCompositeOperation = "source-over";
  fg.clearRect(0, 0, cw, ch);
  fg.setTransform(PR, 0, 0, PR, 0, 0);
  const ox = cw / PR / 2,
    oy = ch / PR - s * 0.06;
  const parts = person(fg, ox, oy, s, facing, P);
  F.parts = parts;
  F.ox = ox;
  F.oy = oy;
  F.hasRim = false;
  return placePerson(F, i, x, y, s, facing);
}

function placePerson(F, i, x, y, s, facing) {
  const cw = F.c.width,
    ch = F.c.height,
    dark = SCHEME !== "light";
  if (!geo.shadowSpr) {
    const { c, g } = makeCanvas(64, 16, 1);
    const gr = g.createRadialGradient(32, 8, 0, 32, 8, 32);
    gr.addColorStop(0, "rgba(0,0,0,1)");
    gr.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 16);
    geo.shadowSpr = c;
  }
  ctx.globalAlpha = dark ? 0.45 : 0.3;
  ctx.drawImage(geo.shadowSpr, x + s * 0.12 - s * 0.3, y - s * 0.05, s * 0.6, s * 0.1);
  ctx.globalAlpha = 1;
  const left = x - F.ox,
    top = y - F.oy;
  if (F.hasRim) ctx.drawImage(F.rim, left - 1.3, top - 0.5, cw / PR, ch / PR);
  ctx.drawImage(F.c, left, top, cw / PR, ch / PR);
  const parts = F.parts;
  const S = (q) => [x + facing * q[0] * s, y + q[1] * s];
  return { hand0: S(parts.hand0), hand1: S(parts.hand1), head: S(parts.head) };
}

/* ── Vehicles: modern (2026) designs, original and unbadged. Units: 1/100 of the car's length,
   facing right, ground at y = 0. Path commands: m/l move-line, q quadratic. ─────────────── */

const BODIES = {
  hyper: {
    r: 7.7,
    fa: 31,
    ra: -29.5,
    wheel: "spoke",
    caliper: "#f2c230",
    body: [
      ["m", 50.5, -6],
      ["l", 50.2, -9.2],
      ["q", 47.5, -10.8, 41, -11.8],
      ["l", 22, -15.8],
      ["l", -1, -25],
      ["q", -8, -25.8, -14, -24.6],
      ["l", -40, -20],
      ["l", -47.5, -19],
      ["l", -49.6, -15.5],
      ["l", -50, -8.5],
      ["l", -48.5, -5],
    ],
    glass: [
      ["m", 18.5, -16.4],
      ["l", -1.2, -24.2],
      ["q", -7, -24.8, -12.5, -23.6],
      ["l", -15.5, -19],
      ["l", -6, -16.8],
    ],
    intake: [
      ["m", -13.5, -17.6],
      ["l", -24.5, -19.2],
      ["q", -26.5, -13, -23.5, -8.2],
      ["l", -12, -8.5],
      ["q", -14.5, -12, -13.5, -17.6],
    ],
    crease: [
      ["m", 41, -10.6],
      ["q", 20, -13.2, 0, -13.6],
      ["l", -42, -15.6],
    ],
    front: [
      ["m", 40, -11.9],
      ["l", 47.5, -10.4],
      ["l", 47, -9.6],
      ["l", 41, -10.9],
    ],
    rear: [
      ["m", -49.5, -15.6],
      ["l", -43, -17.2],
      ["l", -43.2, -16.2],
      ["l", -49.6, -14.6],
    ],
    driver: [4, -20.5],
  },
  gt: {
    r: 7.6,
    fa: 31,
    ra: -29.5,
    wheel: "spoke",
    caliper: "#d8202a",
    body: [
      ["m", 50.5, -6.8],
      ["q", 51, -9.8, 48, -10.8],
      ["q", 38, -12.8, 24, -15.2],
      ["q", 12, -22.8, -2, -25.2],
      ["q", -16, -25.5, -28, -21.2],
      ["q", -40, -19.2, -47, -17.8],
      ["l", -49.8, -16.3],
      ["q", -50.6, -11, -49.5, -5.8],
    ],
    glass: [
      ["m", 19.5, -15.9],
      ["q", 10, -22.3, -1, -24],
      ["q", -11, -24.2, -19, -20.8],
      ["l", -8, -16.4],
    ],
    intake: [
      ["m", -6.5, -12],
      ["q", -14, -17, -22, -15.6],
      ["q", -16.5, -12.2, -18.5, -7.8],
      ["q", -9.5, -9.2, -6.5, -12],
    ],
    crease: [
      ["m", 44, -12],
      ["q", 20, -14.4, -2, -14],
      ["q", -26, -14, -46, -16.2],
    ],
    front: [
      ["m", 42, -11.8],
      ["l", 48.6, -10.6],
      ["l", 48.3, -9.9],
      ["l", 42.5, -11],
    ],
    rear: [
      ["m", -49.8, -16.2],
      ["l", -45.5, -17.1],
      ["l", -45.5, -16.1],
      ["l", -49.9, -15.2],
    ],
    driver: [2, -20.5],
  },
  sedan: {
    r: 7.4,
    fa: 32,
    ra: -31,
    wheel: "aero",
    body: [
      ["m", 50.5, -8],
      ["q", 51, -12, 47, -13.2],
      ["l", 30, -15.8],
      ["q", 22, -17, 16, -19],
      ["q", 6, -27.5, -6, -28],
      ["q", -24, -27.8, -38, -21.5],
      ["q", -46, -19.6, -49.6, -18.5],
      ["q", -50.8, -13, -49.6, -6.5],
    ],
    glass: [
      ["m", 15, -19.2],
      ["q", 6, -26.3, -6, -26.6],
      ["q", -20, -26.4, -31, -21.2],
      ["l", -28, -19.6],
      ["l", 12, -18.6],
    ],
    crease: [
      ["m", 46, -13.4],
      ["l", -48, -16.8],
    ],
    front: [
      ["m", 44, -13.6],
      ["l", 50, -12.6],
      ["l", 50, -11.8],
      ["l", 44, -12.8],
    ],
    rear: [
      ["m", -49.8, -18.3],
      ["l", -42, -19.6],
      ["l", -42, -18.8],
      ["l", -50, -17.5],
    ],
    handles: [
      [6, -17.4],
      [-18, -17.4],
    ],
    driver: [2, -22],
  },
  suv: {
    r: 9.2,
    fa: 32,
    ra: -32,
    wheel: "aero",
    body: [
      ["m", 50.5, -11],
      ["q", 51, -17, 48, -19.5],
      ["l", 32, -22.5],
      ["q", 24, -24, 20, -26.5],
      ["q", 10, -36.5, -6, -37],
      ["q", -26, -36.5, -40, -29.5],
      ["q", -48, -27, -50, -25],
      ["l", -50.4, -12],
      ["q", -50.3, -8.5, -48.6, -8],
    ],
    glass: [
      ["m", 18.5, -26.4],
      ["q", 9, -34.6, -6, -35],
      ["q", -22, -34.6, -34, -28.6],
      ["l", -31, -26.6],
      ["l", 14, -25.9],
    ],
    crease: [
      ["m", 47, -19.8],
      ["l", -49, -23.5],
    ],
    cladding: true,
    front: [
      ["m", 43, -20.6],
      ["l", 50.3, -19.4],
      ["l", 50.3, -18.6],
      ["l", 43, -19.8],
    ],
    rear: [
      ["m", -50.2, -25],
      ["l", -42, -26.6],
      ["l", -42, -25.6],
      ["l", -50.3, -24],
    ],
    handles: [
      [8, -24.5],
      [-16, -24.5],
    ],
    driver: [3, -29],
  },
  roadster: {
    r: 7.6,
    fa: 31,
    ra: -29.5,
    wheel: "spoke",
    caliper: "#f2f2f2",
    open: true,
    body: [
      ["m", 50.5, -6.8],
      ["q", 51, -9.8, 48, -10.8],
      ["q", 38, -12.8, 24, -15.4],
      ["l", 15, -16.8],
      ["l", -14, -17.2],
      ["q", -20, -21, -26, -19.8],
      ["q", -40, -19, -47.5, -17.6],
      ["l", -49.8, -16.2],
      ["q", -50.6, -11, -49.5, -5.8],
    ],
    shield: [
      ["m", 16, -16.8],
      ["l", 9.5, -24],
      ["l", 11, -24.2],
      ["l", 18.5, -16.8],
    ],
    intake: [
      ["m", -6.5, -11.5],
      ["q", -14, -16, -22, -15],
      ["q", -16.5, -12, -18.5, -7.8],
      ["q", -9.5, -9, -6.5, -11.5],
    ],
    crease: [
      ["m", 44, -12],
      ["q", 20, -14.4, -2, -14],
      ["q", -26, -14, -46, -16.2],
    ],
    front: [
      ["m", 42, -11.8],
      ["l", 48.6, -10.6],
      ["l", 48.3, -9.9],
      ["l", 42.5, -11],
    ],
    rear: [
      ["m", -49.8, -16.2],
      ["l", -45.5, -17.1],
      ["l", -45.5, -16.1],
      ["l", -49.9, -15.2],
    ],
  },
};
BODIES.taxi = Object.assign({}, BODIES.sedan, { sign: true });
BODIES.police = Object.assign({}, BODIES.sedan, { lightbar: true });

function cmdPath(cmds, close = true) {
  const p = new Path2D();
  for (const c of cmds) {
    if (c[0] === "m") p.moveTo(c[1], c[2]);
    else if (c[0] === "l") p.lineTo(c[1], c[2]);
    else p.quadraticCurveTo(c[1], c[2], c[3], c[4]);
  }
  if (close) p.closePath();
  return p;
}
function bodyPath(B) {
  // The top line runs nose to tail; the underside comes back tail to nose over both arches.
  const p = cmdPath(B.body, false);
  const r = B.r + 1.2,
    y = -B.r;
  p.lineTo(B.ra - r, -4.6);
  p.arc(B.ra, y, r, Math.PI - 0.32, 0.32);
  p.lineTo(B.fa - r, -4.6);
  p.arc(B.fa, y, r, Math.PI - 0.32, 0.32);
  p.closePath();
  return p;
}
function topOf(B) {
  let m = 0;
  for (const c of B.body) for (let i = 2; i < c.length; i += 2) m = Math.min(m, c[i]);
  return m;
}

function wheel(B, x, t, still, dark, centred = false) {
  const r = B.r,
    y = centred ? 0 : -r;
  // Tyre with a thin low-profile sidewall.
  ctx.fillStyle = "#0b0a0d";
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  const rr = r * 0.78;
  const rim = ctx.createRadialGradient(x - rr * 0.3, y - rr * 0.35, 0, x, y, rr);
  rim.addColorStop(0, dark ? "#55525c" : "#e9e8ec");
  rim.addColorStop(0.7, dark ? "#26252c" : "#9a99a2");
  rim.addColorStop(1, dark ? "#141318" : "#55545c");
  ctx.fillStyle = rim;
  ctx.beginPath();
  ctx.arc(x, y, rr, 0, Math.PI * 2);
  ctx.fill();
  if (B.caliper) {
    ctx.fillStyle = B.caliper;
    ctx.beginPath();
    ctx.arc(x, y, rr * 0.72, -2.4, -1.2);
    ctx.arc(x, y, rr * 0.45, -1.2, -2.4, true);
    ctx.closePath();
    ctx.fill();
  }
  const a0 = t; // the car's own spin angle
  if (B.wheel === "spoke") {
    // Ten slim spokes; a faint blurred disc behind them when moving.
    ctx.strokeStyle = dark ? "rgba(92,90,100,0.9)" : "rgba(235,234,238,0.95)";
    ctx.lineWidth = rr * 0.09;
    for (let i = 0; i < 10; i++) {
      const a = a0 + (i * Math.PI) / 5;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a) * rr * 0.2, y + Math.sin(a) * rr * 0.2);
      ctx.lineTo(x + Math.cos(a + 0.12) * rr * 0.95, y + Math.sin(a + 0.12) * rr * 0.95);
      ctx.stroke();
    }
  } else {
    // Aero disc with five slim slots.
    ctx.fillStyle = dark ? "rgba(20,20,24,0.9)" : "rgba(40,40,46,0.85)";
    for (let i = 0; i < 5; i++) {
      const a = a0 + (i * Math.PI * 2) / 5;
      ctx.beginPath();
      ctx.arc(x, y, rr * 0.88, a, a + 0.32);
      ctx.arc(x, y, rr * 0.55, a + 0.32, a, true);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.fillStyle = dark ? "#2a2830" : "#3a3940";
  ctx.beginPath();
  ctx.arc(x, y, rr * 0.16, 0, Math.PI * 2);
  ctx.fill();
}

function occupants(t, still) {
  // Two people in the open roadster, seated low; the passenger's hair streams back.
  const seat = (px, shirt, hair, long) => {
    ctx.fillStyle = shirt;
    ctx.beginPath();
    ctx.roundRect(px - 3.6, -24.5, 7.2, 9, 3);
    ctx.fill();
    ctx.fillStyle = L.skin;
    ctx.beginPath();
    ctx.ellipse(px + 0.4, -27.6, 2.3, 2.8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#101014";
    ctx.fillRect(px + 0.9, -28.4, 2, 0.9);
    ctx.fillStyle = hair;
    ctx.beginPath();
    ctx.ellipse(px - 0.2, -29.6, 2.6, 1.5, 0, 0, Math.PI * 2);
    ctx.fill();
    if (long) {
      const w = still ? 0 : Math.sin(t * 0.02) * 0.8;
      ctx.strokeStyle = hair;
      ctx.lineCap = "round";
      ctx.lineWidth = 1;
      for (let i = 0; i < 5; i++) {
        ctx.beginPath();
        ctx.moveTo(px - 1.4, -29.4 + i * 0.7);
        ctx.quadraticCurveTo(px - 6, -30 + i * 0.8 + w, px - 10 - i * 1.2, -27.5 + i * 1.1 - w);
        ctx.stroke();
      }
    }
  };
  seat(-9, L.cloth[2], "#3a2216", true);
  seat(1.5, L.cloth[1], "#2a1a14", false);
  ctx.strokeStyle = L.skin;
  ctx.lineWidth = 1.4;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(3.5, -22);
  ctx.lineTo(9, -20);
  ctx.stroke();
}

function paintBody(type, x, y, len, dir, paint) {
  const t = 0,
    still = true;
  const dark = SCHEME !== "light";
  const B = BODIES[type];
  const u = len / 100;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(u * dir, u);
  // Ground shadow and contact shadows under the tyres.
  const sh = ctx.createRadialGradient(0, -1, 0, 0, -1, 58);
  sh.addColorStop(0, "rgba(0,0,0,0.55)");
  sh.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = sh;
  ctx.beginPath();
  ctx.ellipse(0, 0, 58, 4.5, 0, 0, Math.PI * 2);
  ctx.fill();
  for (const wx of [B.fa, B.ra]) {
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.beginPath();
    ctx.ellipse(wx, 0, B.r * 0.9, 1.2, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  if (B.open) occupants(t, still);
  // Paint: sky reflection on the upper surfaces, body colour, a horizon band, darker sills.
  const body = bodyPath(B);
  const top = topOf(B);
  const pg = ctx.createLinearGradient(0, top, 0, 0);
  pg.addColorStop(0, dark ? mixHex(paint[0], "#ff9a8a", 0.45) : mixHex(paint[0], "#ffffff", 0.55));
  pg.addColorStop(0.3, paint[0]);
  pg.addColorStop(0.62, paint[0]);
  pg.addColorStop(1, paint[1]);
  ctx.fillStyle = pg;
  ctx.fill(body);
  ctx.save();
  ctx.clip(body);
  const band = top * 0.42;
  ctx.fillStyle = dark ? "rgba(20,8,30,0.28)" : "rgba(40,60,90,0.16)";
  ctx.fillRect(-55, band, 110, 2.2);
  ctx.fillStyle = dark ? "rgba(255,150,170,0.14)" : "rgba(255,255,255,0.28)";
  ctx.fillRect(-55, band - 3.2, 110, 2.6);
  const sill = ctx.createLinearGradient(0, -9, 0, 0);
  sill.addColorStop(0, "rgba(0,0,0,0)");
  sill.addColorStop(1, "rgba(0,0,0,0.45)");
  ctx.fillStyle = sill;
  ctx.fillRect(-55, -9, 110, 9);
  if (B.cladding) {
    ctx.fillStyle = "rgba(14,14,18,0.85)";
    ctx.fillRect(-55, -9.5, 110, 9.5);
  }
  for (const wx of [B.fa, B.ra]) {
    // Shadow inside the top of each arch.
    const ag = ctx.createRadialGradient(wx, -B.r, B.r * 0.9, wx, -B.r, B.r * 1.9);
    ag.addColorStop(0, "rgba(0,0,0,0.35)");
    ag.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = ag;
    ctx.fillRect(wx - B.r * 2, -B.r * 3, B.r * 4, B.r * 3);
  }
  if (B.intake) {
    ctx.fillStyle = "rgba(8,8,12,0.88)";
    ctx.fill(cmdPath(B.intake));
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 0.4;
    for (let k = 0; k < 4; k++) {
      ctx.beginPath();
      ctx.moveTo(-24 + k * 3, -16);
      ctx.lineTo(-22 + k * 3, -9);
      ctx.stroke();
    }
  }
  ctx.restore();
  // Crease: a crisp highlight, kept inside the body.
  ctx.save();
  ctx.clip(body);
  ctx.strokeStyle = dark ? "rgba(255,200,190,0.55)" : "rgba(255,255,255,0.85)";
  ctx.lineWidth = 0.5;
  ctx.stroke(cmdPath(B.crease, false));
  ctx.restore();
  // Glass: blacked out, with a diagonal reflection; a faint driver behind it.
  if (B.glass) {
    const gp = cmdPath(B.glass);
    const gg = ctx.createLinearGradient(-30, top, 20, -14);
    gg.addColorStop(0, "#0b0a10");
    gg.addColorStop(0.45, dark ? "#2a1a2e" : "#33404e");
    gg.addColorStop(0.55, dark ? "#5a3a4e" : "#7f97ab");
    gg.addColorStop(0.65, "#151520");
    gg.addColorStop(1, "#0b0a10");
    ctx.fillStyle = gg;
    ctx.fill(gp);
    if (B.driver) {
      ctx.save();
      ctx.clip(gp);
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.beginPath();
      ctx.ellipse(B.driver[0], B.driver[1] - 2.5, 2.4, 2.9, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(B.driver[0] - 3.5, B.driver[1], 7, 6);
      ctx.restore();
    }
  }
  if (B.shield) {
    ctx.fillStyle = dark ? "rgba(255,170,170,0.25)" : "rgba(200,230,250,0.5)";
    ctx.fill(cmdPath(B.shield));
    ctx.strokeStyle = "#151418";
    ctx.lineWidth = 0.5;
    ctx.stroke(cmdPath(B.shield));
  }
  if (B.lightbar) {
    const ty = topOf(B);
    ctx.fillStyle = "#1a1a1e";
    ctx.fillRect(-14, ty - 2.6, 18, 2.6);
    ctx.fillStyle = "#f4f4f6"; // door panel
    ctx.fillRect(-12, -18, 26, 5);
    ctx.fillStyle = "#16161c";
    ctx.font = "700 2.6px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("POLICE", 1, -15.5);
  }
  if (B.handles) {
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    for (const [hx, hy] of B.handles) ctx.fillRect(hx, hy, 4, 0.6);
  }
  if (B.sign) {
    const ty = topOf(B);
    ctx.fillStyle = "#fffbe0";
    ctx.beginPath();
    ctx.roundRect(-11, ty - 3.4, 12, 3.6, 1);
    ctx.fill();
    ctx.fillStyle = "#121212";
    ctx.font = "700 2.6px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("TAXI", -5, ty - 1.55);
  }
  // Mirror.
  ctx.fillStyle = "#121216";
  ctx.beginPath();
  const mx = B.glass ? B.glass[0][1] - 2.5 : 14;
  ctx.ellipse(mx, B.glass ? B.glass[0][2] - 0.8 : -18, 1.8, 1.1, 0, 0, Math.PI * 2);
  ctx.fill();
  // LED lights.
  ctx.fillStyle = "#fffdf2";
  ctx.fill(cmdPath(B.front));
  ctx.fillStyle = "#ff1f45";
  ctx.fill(cmdPath(B.rear));
  // Dark wheel wells (the wheels themselves are drawn live).
  ctx.save();
  ctx.beginPath();
  ctx.rect(-60, -60, 120, 56);
  ctx.clip();
  ctx.fillStyle = "#07060a";
  for (const wx of [B.fa, B.ra]) {
    ctx.beginPath();
    ctx.arc(wx, -B.r, B.r + 1.15, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  ctx.restore();
}

/* Cars are painted once per model, colour, size, direction and scheme; each frame places the
   cached body, turns cached wheels, and draws only the live lights. */
function carSprite(type, paint, len, dir) {
  const key = `${type}|${paint[0]}|${Math.round(len)}|${dir}|${SCHEME}`;
  geo.carCache = geo.carCache || new Map();
  let c = geo.carCache.get(key);
  if (c) return c;
  const w = len * 1.22,
    h = len * 0.5,
    ox = w / 2,
    oy = h - len * 0.03;
  const C = makeCanvas(w, h, PR);
  const saved = ctx;
  ctx = C.g;
  paintBody(type, ox, oy, len, dir, paint);
  ctx = saved;
  c = { c: C.c, w, h, ox, oy };
  geo.carCache.set(key, c);
  return c;
}

function rimSprite(type, R) {
  const key = `${type}|${Math.round(R * 10)}|${SCHEME}`;
  geo.rimCache = geo.rimCache || new Map();
  let c = geo.rimCache.get(key);
  if (c) return c;
  const B = BODIES[type],
    dark = SCHEME !== "light";
  const C = makeCanvas(R * 2, R * 2, PR);
  const saved = ctx;
  ctx = C.g;
  ctx.translate(R, R);
  ctx.scale(R / B.r, R / B.r);
  wheel(Object.assign({}, B, { caliper: null }), 0, 0, true, dark, true);
  ctx = saved;
  geo.rimCache.set(key, C.c);
  return C.c;
}

function vehicle(type, x, y, len, dir, paint, t, still, spin = 0) {
  const dark = SCHEME !== "light";
  const B = BODIES[type];
  const u = len / 100;
  if (dark) {
    if (!geo.beamSpr || geo.beamLen !== Math.round(len)) {
      const C = makeCanvas(140 * u, 40 * u, PR);
      const bg = C.g.createLinearGradient(0, 0, 140 * u, 0);
      bg.addColorStop(0, rgba(L.head, 0.28));
      bg.addColorStop(1, rgba(L.head, 0));
      C.g.fillStyle = bg;
      C.g.beginPath();
      C.g.moveTo(0, 18 * u);
      C.g.lineTo(140 * u, 0);
      C.g.lineTo(140 * u, 40 * u);
      C.g.closePath();
      C.g.fill();
      geo.beamSpr = C.c;
      geo.beamLen = Math.round(len);
    }
    const hy = y + B.front[1][2] * u;
    ctx.save();
    ctx.translate(x + dir * 50 * u, hy - 18 * u);
    ctx.scale(dir, 1);
    ctx.drawImage(geo.beamSpr, 0, 0, 140 * u, 40 * u);
    ctx.restore();
  }
  const S = carSprite(type, paint, len, dir);
  ctx.drawImage(S.c, x - S.ox, y - S.oy, S.w, S.h);
  // Wheels: a cached rim, turned by the distance travelled; calipers stay put.
  const R = B.r * u,
    rim = rimSprite(type, R);
  for (const wx of [B.fa, B.ra]) {
    const cx = x + dir * wx * u,
      cy = y - B.r * u;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(spin * dir);
    ctx.drawImage(rim, -R, -R, R * 2, R * 2);
    ctx.restore();
    if (B.caliper) {
      ctx.fillStyle = B.caliper;
      ctx.beginPath();
      const rr = R * 0.78;
      const a0 = dir > 0 ? -2.4 : Math.PI + 1.2,
        a1 = dir > 0 ? -1.2 : Math.PI + 2.4;
      ctx.arc(cx, cy, rr * 0.72, a0, a1);
      ctx.arc(cx, cy, rr * 0.45, a1, a0, true);
      ctx.closePath();
      ctx.fill();
    }
  }
  if (B.lightbar) {
    const ty = y + topOf(B) * u,
      on = Math.floor(t / 160) % 2;
    const lx = (k) => x + dir * k * u;
    ctx.fillStyle = on ? "#ff2a3a" : "#5a0f16";
    ctx.fillRect(Math.min(lx(-13.5), lx(-5.5)), ty - 2.3 * u, 8 * u, 2 * u);
    ctx.fillStyle = on ? "#1f3cff" : "#0c1650";
    ctx.fillRect(Math.min(lx(-4.5), lx(3.5)), ty - 2.3 * u, 8 * u, 2 * u);
    const sprB = spr.blue || (spr.blue = sprite([60, 90, 255], 0.9));
    ctx.globalAlpha = still ? 0.6 : 1;
    ctx.drawImage(
      on ? spr.tail : sprB,
      lx(on ? -9.5 : -0.5) - 14 * u,
      ty - 11.3 * u,
      28 * u,
      20 * u,
    );
    ctx.globalAlpha = 1;
  }
  if (dark) {
    const fx = x + dir * B.front[1][1] * u,
      fy = y + B.front[1][2] * u;
    const rx = x + dir * B.rear[0][1] * u,
      ry = y + B.rear[0][2] * u;
    ctx.drawImage(spr.head, fx - 6 * u, fy - 5 * u, 12 * u, 10 * u);
    ctx.drawImage(spr.tail, rx - 6 * u, ry - 5 * u, 12 * u, 10 * u);
  }
}

function mixHex(a, b, k) {
  const A = hexrgb(a),
    Bc = hexrgb(b);
  return `rgb(${[0, 1, 2].map((i) => Math.round(A[i] + (Bc[i] - A[i]) * k)).join(",")})`;
}

/* ── Traffic: a small simulation. Cars enter each lane at random intervals with their own
   cruising speed; a faster car that closes on a slower one brakes and follows at a safe gap,
   then pulls away when the road clears. Wheels turn with the distance each car covers. ──── */

const FLEET = [
  [
    "sedan",
    3,
    [
      ["#cfd3da", "#7d828e"],
      ["#3a3d46", "#1a1c22"],
      ["#f2f2f4", "#a4a6ae"],
      ["#1f3a6e", "#0c1a36"],
      ["#151519", "#050507"],
    ],
    [0.75, 1.05],
  ],
  [
    "suv",
    3,
    [
      ["#ecedf0", "#9a9ca6"],
      ["#1c1d24", "#08080c"],
      ["#6b6f78", "#33363d"],
      ["#c8b89a", "#7a6c52"],
    ],
    [0.7, 1.0],
  ],
  ["taxi", 2, [["#f7c41a", "#a37d06"]], [0.75, 1.0]],
  [
    "hyper",
    1,
    [
      ["#ff6a12", "#a43a04"],
      ["#8fdc2a", "#3f7a0e"],
      ["#5b5f68", "#24262c"],
    ],
    [1.15, 1.6],
  ],
  [
    "gt",
    1,
    [
      ["#d41e2c", "#6e0a12"],
      ["#f5c518", "#8a6a00"],
      ["#f4f4f6", "#a2a4ac"],
    ],
    [1.1, 1.5],
  ],
  [
    "roadster",
    1,
    [
      ["#18b3ad", "#0b6a66"],
      ["#d41e2c", "#6e0a12"],
    ],
    [0.95, 1.3],
  ],
];
const FLEET_W = FLEET.reduce((a, f) => a + f[1], 0);

function newCar(rnd, lane) {
  let r = rnd() * FLEET_W,
    f = FLEET[0];
  for (const it of FLEET) {
    r -= it[1];
    if (r <= 0) {
      f = it;
      break;
    }
  }
  const [type, , paints, [lo, hi]] = f;
  const want = geo.baseSpeed * lane.k * (lo + rnd() * (hi - lo));
  return {
    type,
    paint: paints[(rnd() * paints.length) | 0],
    want,
    v: want,
    pos: 0,
    spin: rnd() * 6,
  };
}

function makeTraffic() {
  const rnd = seeded(2026);
  geo.trafficRnd = rnd;
  geo.baseSpeed = W / 11000; // px per ms: an average car crosses in about 11 s
  const carLen = geo.s * 2.6;
  geo.lanes = [
    {
      y: geo.road + (geo.curb - geo.road) * 0.46,
      k: 0.88,
      dir: -1,
      len: carLen * 0.88,
      cars: [],
      next: 0,
    },
    {
      y: geo.road + (geo.curb - geo.road) * 0.96,
      k: 1.04,
      dir: 1,
      len: carLen * 1.04,
      cars: [],
      next: 0,
    },
  ];
  // Start with the road already in use: cars spread along each lane with random gaps.
  for (const ln of geo.lanes) {
    let pos = W + ln.len;
    while (pos > -ln.len) {
      const c = newCar(rnd, ln);
      c.pos = pos;
      ln.cars.push(c);
      pos -= ln.len * (1.3 + rnd() * 2.6);
    }
    ln.cars.sort((a, b) => b.pos - a.pos); // leader first
    ln.next = rnd() * 2500;
  }
}

function stepTraffic(dt, clock) {
  const rnd = geo.trafficRnd;
  for (const ln of geo.lanes) {
    const span = W + ln.len * 2;
    // Spawn at the entry when it's time (or a police car is due) and the entry is clear.
    const last = ln.cars[ln.cars.length - 1];
    const police = ln.dir > 0 && geo.policeDue != null;
    if ((clock >= ln.next || police) && (!last || last.pos > ln.len * (police ? 1.15 : 1.6))) {
      const c = newCar(rnd, ln);
      if (police) {
        Object.assign(c, {
          type: "police",
          paint: ["#f4f4f6", "#16161c"],
          want: geo.baseSpeed * 1.5 * ln.k,
        });
        c.v = c.want;
        geo.policeDue = null;
      }
      c.pos = -ln.len;
      if (last) c.v = Math.min(c.v, last.v * 1.05);
      ln.cars.push(c);
      ln.next = clock + 700 + rnd() * 4800;
    }
    // Move: leader first; each follower keeps a speed-dependent safe gap.
    for (let i = 0; i < ln.cars.length; i++) {
      const c = ln.cars[i];
      let target = c.want;
      if (i > 0) {
        const ahead = ln.cars[i - 1];
        const gap = ahead.pos - c.pos - ln.len;
        const safe = ln.len * 0.35 + c.v * 650;
        if (gap < safe) target = Math.min(target, ahead.v * Math.max(0, gap / safe));
      }
      const acc = target > c.v ? 0.00004 : 0.00016; // gentle acceleration, firmer braking
      c.v += Math.max(-acc * dt, Math.min(acc * dt, target - c.v));
      c.v = Math.max(0, c.v);
      c.pos += c.v * dt;
      if (i > 0) c.pos = Math.min(c.pos, ln.cars[i - 1].pos - ln.len * 1.08);
      c.spin += (c.v * dt) / (ln.len * 0.08);
    }
    ln.cars = ln.cars.filter((c) => c.pos < span);
  }
}

// Walk phase for distance d at height h.
const stride = (d, h) => (d / (0.62 * h)) * Math.PI * 2;

function draw(t, still) {
  geo.frameNo = (geo.frameNo || 0) + 1;
  ctx.setTransform(PR, 0, 0, PR, 0, 0);
  ctx.drawImage(back, 0, 0, W, H);
  const { horizon, beach } = geo;

  // Shimmer on the sun's path and small waves.
  for (let i = 0; i < 70; i++) {
    const r = ((i * 9301 + 49297) % 233280) / 233280;
    const y = horizon + 2 + Math.pow(r, 1.4) * (beach - horizon - 4);
    const spread = geo.sunR * (0.4 + ((y - horizon) / (beach - horizon)) * 1.5);
    const x = geo.sunX + (((i * 7919) % 1000) / 1000 - 0.5) * spread * 2;
    const a = still ? 0.5 : Math.max(0, Math.sin(t * 0.003 + i * 1.7));
    ctx.fillStyle = rgba(L.shimmer, 0.7 * a);
    ctx.fillRect(x, y, 6 + r * 14, 1.2);
  }
  // Speedboat crossing every 26 s with a widening wake.
  const bc = still ? 0.4 : (t % 26000) / 26000;
  const bx = -60 + bc * (W * 0.56 + 60),
    by = horizon + (beach - horizon) * 0.45;
  ctx.globalAlpha = Math.min(1, (1 - bc) * 8);
  ctx.fillStyle = L.wake;
  ctx.beginPath();
  ctx.moveTo(bx - 4, by);
  ctx.lineTo(bx - 120, by - 6);
  ctx.lineTo(bx - 120, by + 8);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = L.boat;
  ctx.beginPath();
  ctx.moveTo(bx - 16, by - 4);
  ctx.lineTo(bx + 14, by - 4);
  ctx.lineTo(bx + 20, by - 1);
  ctx.lineTo(bx - 14, by + 1);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(bx - 6, by - 8, 8, 4);
  ctx.globalAlpha = 1;

  // Rooftop neon signs: glow, letters, and a rare flicker.
  for (const n of neons) {
    const ph = (t * 0.0007 + n.p) % 9;
    const on = still ? 1 : ph < 0.1 ? 0.3 : ph < 0.16 ? 1 : ph < 0.22 ? 0.4 : 1;
    const fs = Math.max(9, n.w * 0.2);
    ctx.font = `italic 700 ${fs}px Futura, "Avenir Next", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (SCHEME !== "light") {
      ctx.globalAlpha = 0.4 * on;
      const sp = spr.neon[L.neon.indexOf(n.col)] || spr.neon[0];
      ctx.drawImage(sp, n.x - n.w * 0.7, n.y - fs * 1.4, n.w * 1.4, fs * 2.8);
    }
    ctx.globalAlpha = (SCHEME === "light" ? 0.85 : 1) * on;
    ctx.fillStyle = n.col;
    ctx.fillText(n.text, n.x, n.y);
  }
  ctx.globalAlpha = 1;

  // Palm crowns: each sprite sways as a whole in the breeze.
  for (const pm of palms) {
    const sw = still
      ? 0
      : Math.sin(t * 0.0009 + pm.p) * 0.035 + Math.sin(t * 0.0023 + pm.p * 2) * 0.012;
    ctx.save();
    ctx.translate(pm.x, pm.y);
    ctx.rotate(sw);
    ctx.drawImage(pm.sprite, -pm.ox, -pm.oy, pm.sw, pm.sh);
    ctx.restore();
  }

  // Gulls.
  for (const gl of gulls) {
    const x = ((gl.x + (still ? 0 : t * gl.v)) % 1.1) * W - W * 0.05;
    const y = gl.y * H + Math.sin(t * 0.001 + gl.p) * 6;
    const flap = still ? 0.4 : Math.sin(t * 0.012 + gl.p * 5);
    const s = 7 * gl.s;
    ctx.strokeStyle = L.gull;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(x - s, y - flap * s * 0.6);
    ctx.quadraticCurveTo(x - s * 0.4, y - s * 0.4, x, y);
    ctx.quadraticCurveTo(x + s * 0.4, y - s * 0.4, x + s, y - flap * s * 0.6);
    ctx.stroke();
  }
  // A far helicopter over the hotels.
  const hx = still ? W * 0.8 : W * (0.62 + 0.3 * ((t % 60000) / 60000)),
    hy = H * 0.2 + Math.sin(t * 0.001) * 4;
  ctx.fillStyle = L.gull;
  ctx.beginPath();
  ctx.ellipse(hx, hy, 7, 3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(hx - 15, hy - 1, 10, 1.5);
  ctx.fillRect(hx - 10, hy - 5, 20, 0.8);
  if (still || t % 1100 < 140) {
    ctx.drawImage(spr.tail, hx - 18, hy - 4, 8, 8);
  }

  // ── The crowd ──────────────────────────────────────────────────────────────────────────
  const s = geo.s,
    O = geo.out,
    R = geo.rows,
    sb = s * 0.93;
  const T = still ? 0 : t;
  const loopX = (period, offset, dir, pad) => {
    const k = ((((T + offset) % period) + period) % period) / period;
    const d = k * (W + pad * 2);
    return { x: dir > 0 ? -pad + d : W + pad - d, d };
  };

  // A couple at the waterline, watching the sun.
  drawPerson(
    11,
    W * 0.47,
    R.shore,
    s * 0.62,
    -1,
    standPose(O.shore1, T, 1, { arm: [0.25, -0.06] }),
  );
  drawPerson(
    12,
    W * 0.47 - s * 0.62 * 0.28,
    R.shore,
    s * 0.6,
    -1,
    standPose(O.shore2, T, 2, { arm: [0.06, 0.32], headTilt: 0.15 }),
  );

  // Back row: someone taking a selfie, a person walking a dog, the couple's partner, a friend in the chat.
  const selfie = drawPerson(
    5,
    W * 0.18,
    R.back,
    sb,
    1,
    standPose(O.selfie, T, 3, {
      arm: [2.35 + Math.sin(T * 0.0015) * 0.05, -0.1],
      elbow: [-0.55, 0.12],
      headTilt: -0.12,
      hip: [0.1, -0.08],
    }),
  );
  ctx.globalAlpha = 0.6;
  ctx.drawImage(
    spr.lamp,
    selfie.hand0[0] - s * 0.08,
    selfie.hand0[1] - s * 0.1,
    s * 0.16,
    s * 0.16,
  );
  ctx.globalAlpha = 1;

  const dw = loopX(38000, 4000, 1, s * 1.5);
  const dogger = drawPerson(
    10,
    dw.x,
    R.back,
    sb,
    1,
    walkPose(stride(dw.d, sb), O.dogger, { arm: [0.45, -0.25], elbow: [0.1, 0.2] }),
  );
  // The dog trots ahead on a leash.
  const dx = dw.x + sb * 0.55,
    dy = R.back,
    dp = stride(dw.d, sb) * 1.6,
    ds = sb * 0.28;
  ctx.strokeStyle = "rgba(20,20,24,0.8)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(dogger.hand0[0], dogger.hand0[1]);
  ctx.quadraticCurveTo((dogger.hand0[0] + dx) / 2, dy - ds * 0.3, dx - ds * 0.3, dy - ds * 0.62);
  ctx.stroke();
  ctx.fillStyle = SCHEME === "light" ? "#c8925a" : "#3a2418";
  ctx.beginPath();
  ctx.ellipse(dx, dy - ds * 0.55, ds * 0.42, ds * 0.17, 0, 0, Math.PI * 2);
  ctx.ellipse(dx + ds * 0.42, dy - ds * 0.72, ds * 0.15, ds * 0.12, 0, 0, Math.PI * 2);
  ctx.fill();
  for (let i = 0; i < 4; i++) {
    const lx = dx + (i < 2 ? -ds * 0.28 : ds * 0.26) + (i % 2) * ds * 0.06;
    const sw = Math.sin(dp + i * Math.PI) * ds * 0.12;
    ctx.fillRect(lx + sw, dy - ds * 0.45, ds * 0.07, ds * 0.45);
  }

  // The couple walks left hand in hand: him a step behind on the back row, her in front.
  const cw = loopX(42000, 20000, -1, s * 1.5);
  const ph = stride(cw.d, s);
  const him = drawPerson(
    3,
    cw.x + s * 0.12,
    R.back,
    sb,
    -1,
    walkPose(ph + 0.4, O.him, { arm: [0.32, -0.2], elbow: [0.05, 0.2] }),
  );

  // Chat: one friend on the back row laughing, leaning back now and then.
  const laugh = Math.max(0, Math.sin(T * 0.0021)) * 0.08;
  drawPerson(
    9,
    W * 0.64,
    R.back,
    sb,
    -1,
    standPose(O.chatC, T, 4, {
      lean: -laugh,
      arm: [0.15 + laugh, 0.3],
      elbow: [0.9, 0.9],
      headTilt: -laugh * 2,
    }),
  );

  // Front row.
  const her = drawPerson(
    2,
    cw.x,
    R.front,
    s * 0.96,
    -1,
    walkPose(ph, O.her, { arm: [0.1, 0.38], elbow: [0.05, 0.1] }),
  );
  ctx.strokeStyle = O.her.skin;
  ctx.lineWidth = s * 0.035;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(her.hand1[0], her.hand1[1]);
  ctx.lineTo(him.hand0[0], him.hand0[1]);
  ctx.stroke();

  // Chat: one talks with her hands, the other nods along.
  drawPerson(
    7,
    W * 0.62,
    R.front,
    s,
    1,
    standPose(O.chatA, T, 5, {
      arm: [0.55 + Math.sin(T * 0.004) * 0.3, 0.1],
      elbow: [0.9 + Math.sin(T * 0.006) * 0.3, 0.2],
    }),
  );
  drawPerson(
    8,
    W * 0.62 + s * 0.48,
    R.front,
    s * 0.97,
    -1,
    standPose(O.chatB, T, 6, { headTilt: Math.sin(T * 0.003) * 0.12, arm: [0.12, -0.05] }),
  );

  // Someone waving at the traffic.
  drawPerson(
    6,
    W * 0.36,
    R.front,
    s,
    1,
    standPose(O.waver, T, 7, {
      arm: [Math.PI - 0.45 + Math.sin(T * 0.012) * 0.22, 0.06],
      elbow: [-0.45 + Math.sin(T * 0.012) * 0.25, 0.1],
      headTilt: 0.08,
    }),
  );

  // A jogger heading right, and the skater heading left.
  const jg = loopX(16000, 0, 1, s * 1.5);
  drawPerson(4, jg.x, R.front, s, 1, jogPose((jg.d / (1.0 * s)) * Math.PI * 2, O.jogger));
  const kk = still ? 6000 : t % 21000;
  const kx = W + s * 1.5 - (kk / 21000) * (W + s * 3);
  const push = (kk % 3500) / 3500;
  const pushing = !still && push < 0.32;
  const pp = pushing ? (push / 0.32) * Math.PI * 2 : 0;
  const ky = R.front - s * 0.06;
  ctx.fillStyle = "#16161a";
  ctx.beginPath();
  ctx.roundRect(kx - s * 0.2, ky + s * 0.01, s * 0.4, s * 0.03, s * 0.012);
  ctx.fill();
  for (const o of [-0.14, 0.14]) {
    ctx.beginPath();
    ctx.arc(kx + o * s, ky + s * 0.055, s * 0.022, 0, Math.PI * 2);
    ctx.fill();
  }
  drawPerson(1, kx, ky, s, -1, {
    hip: [0.05, pushing ? 0.3 * Math.sin(pp) - 0.05 : -0.08],
    knee: [0.3, pushing ? 0.4 + 0.3 * Math.max(0, Math.cos(pp)) : 0.32],
    arm: [0.4, -0.55],
    elbow: [0.25, 0.2],
    lean: 0.1,
    hipH: 0.49,
    outfit: O.skater,
  });
  // The stroller in shades.
  const st = loopX(30000, 9000, 1, s * 1.5);
  drawPerson(0, st.x, R.front + s * 0.04, s, 1, walkPose(stride(st.d, s), O.stroller));

  // ── Street life: a musician, a cyclist, and a fight that gets broken up ──────────────────
  // Street musician by a lamp: strumming, with an open case for tips.
  const mx = W * 0.085,
    my = R.back;
  ctx.fillStyle = "#1a1416";
  ctx.beginPath();
  ctx.roundRect(mx + sb * 0.12, my - sb * 0.035, sb * 0.26, sb * 0.04, sb * 0.01);
  ctx.fill();
  ctx.fillStyle = "#7a1f3a";
  ctx.fillRect(mx + sb * 0.135, my - sb * 0.03, sb * 0.23, sb * 0.022);
  const strum = Math.sin(T * 0.022);
  const mus = drawPerson(
    13,
    mx,
    my,
    sb,
    1,
    standPose(geo.out.musician, T, 8, {
      arm: [0.62 + strum * 0.12, 1.15],
      elbow: [1.55, 0.55],
      headTilt: 0.12 + Math.sin(T * 0.004) * 0.05,
    }),
  );
  const gx = mus.hand0[0] - sb * 0.01,
    gy = mus.hand0[1] + sb * 0.015;
  ctx.strokeStyle = "#3a2214";
  ctx.lineWidth = sb * 0.025;
  ctx.beginPath();
  ctx.moveTo(gx, gy);
  ctx.lineTo(mus.hand1[0] + sb * 0.02, mus.hand1[1] - sb * 0.01);
  ctx.stroke();
  ctx.fillStyle = "#b5712e";
  ctx.beginPath();
  ctx.ellipse(gx - sb * 0.01, gy + sb * 0.01, sb * 0.075, sb * 0.055, -0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#1a0f0a";
  ctx.beginPath();
  ctx.arc(gx + sb * 0.005, gy, sb * 0.016, 0, Math.PI * 2);
  ctx.fill();

  // Cyclist along the boardwalk, pedalling at road speed.
  const cy0 = loopX(19000, 6000, 1, s * 1.6);
  const crank = still ? 0.6 : cy0.d / (s * 0.12);
  const cbx = cy0.x,
    cby = R.front + s * 0.02,
    wr = s * 0.17;
  ctx.strokeStyle = "#1c1c22";
  ctx.lineWidth = Math.max(1, s * 0.012);
  for (const wx of [-0.3, 0.32]) {
    ctx.beginPath();
    ctx.arc(cbx + wx * s, cby - wr, wr, 0, Math.PI * 2);
    ctx.stroke();
    for (let k = 0; k < 4; k++) {
      const a = crank * 0.6 + (k * Math.PI) / 2;
      ctx.beginPath();
      ctx.moveTo(cbx + wx * s, cby - wr);
      ctx.lineTo(cbx + wx * s + Math.cos(a) * wr, cby - wr + Math.sin(a) * wr);
      ctx.stroke();
    }
  }
  ctx.strokeStyle = "#16a3a0";
  ctx.lineWidth = Math.max(1.5, s * 0.022);
  ctx.beginPath();
  ctx.moveTo(cbx - 0.3 * s, cby - wr);
  ctx.lineTo(cbx - 0.02 * s, cby - wr);
  ctx.lineTo(cbx + 0.2 * s, cby - s * 0.42);
  ctx.lineTo(cbx - 0.1 * s, cby - s * 0.44);
  ctx.lineTo(cbx - 0.02 * s, cby - wr);
  ctx.moveTo(cbx - 0.1 * s, cby - s * 0.44);
  ctx.lineTo(cbx - 0.3 * s, cby - wr);
  ctx.moveTo(cbx + 0.2 * s, cby - s * 0.42);
  ctx.lineTo(cbx + 0.32 * s, cby - wr);
  ctx.stroke();
  const ped = (o) => [-0.02 + Math.cos(crank + o) * 0.09, -0.17 + Math.sin(crank + o) * 0.09];
  drawPerson(14, cbx - 0.08 * s, cby, s, 1, {
    hip: [0, 0],
    knee: [0, 0],
    feet: [ped(0), ped(Math.PI)].map(([u, v]) => [u + 0.08, v]),
    arm: [1.25, 1.2],
    elbow: [0.25, 0.25],
    lean: 0.42,
    hipH: 0.47,
    outfit: geo.out.cyclist,
  });

  // The fight: an argument, a shove, a scuffle, a peacemaker, then everyone cools off.
  const fk = still ? 16000 : T % 30000;
  const fx = W * 0.5,
    fy = R.front;
  let A = { x: fx - s * 0.3, lean: 0.06, arm: [0.2, -0.1], elbow: [0.3, 0.2], tilt: 0 };
  let Bp = { x: fx + s * 0.3, lean: 0.06, arm: [0.2, -0.1], elbow: [0.3, 0.2], tilt: 0 };
  let peace = null,
    impact = null,
    watching = fk < 11500;
  if (fk < 3500) {
    // Arguing: alternating jabs of the finger, leaning in.
    const w = Math.sin(fk * 0.012);
    A = {
      ...A,
      lean: 0.12,
      arm: [0.9 + Math.max(0, w) * 0.5, -0.1],
      elbow: [0.5, 0.3],
      tilt: 0.06 * w,
    };
    Bp = {
      ...Bp,
      lean: 0.1,
      arm: [0.9 + Math.max(0, -w) * 0.5, 0.1],
      elbow: [0.5, 0.3],
      tilt: -0.06 * w,
    };
  } else if (fk < 4300) {
    // A shoves B, who stumbles back.
    const k = ease((fk - 3500) / 800);
    A = { ...A, lean: 0.2, arm: [1.45, 1.4], elbow: [0.05, 0.05] };
    Bp = {
      ...Bp,
      x: Bp.x + s * 0.28 * k,
      lean: 0.1 - 0.25 * Math.sin(k * Math.PI),
      arm: [-0.3, -0.5],
      elbow: [0.4, 0.4],
    };
  } else if (fk < 7800) {
    // Scuffle: punches thrown in turns, guards up, recoil on contact.
    const turn = Math.floor((fk - 4300) / 500),
      beat = ((fk - 4300) % 500) / 500;
    const ext = beat < 0.35 ? beat / 0.35 : Math.max(0, 1 - (beat - 0.35) / 0.4);
    const guard = { arm: [1.0, 1.15], elbow: [1.9, 1.8] };
    const punch = { arm: [1.0 + 0.55 * ext, 1.15], elbow: [1.9 - 1.85 * ext, 1.8] };
    const hit = ext > 0.85 ? 0.14 : 0;
    const bx2 = Bp.x + s * 0.28;
    if (turn % 2 === 0) {
      A = { ...A, ...punch, lean: 0.14 + 0.08 * ext };
      Bp = { ...Bp, ...guard, x: bx2, lean: 0.12 - hit };
      if (hit) impact = [fx + s * 0.02, fy - s * 0.82];
    } else {
      A = { ...A, ...guard, lean: 0.12 - hit };
      Bp = { ...Bp, ...punch, x: bx2, lean: 0.14 + 0.08 * ext };
      if (hit) impact = [fx - s * 0.02, fy - s * 0.82];
    }
  } else if (fk < 11500) {
    // A peacemaker walks in and holds them apart; they step back.
    const k = ease(Math.min(1, (fk - 7800) / 1500));
    const apart = ease(Math.max(0, Math.min(1, (fk - 8800) / 1400)));
    A = { ...A, x: A.x - s * 0.22 * apart, lean: 0.04, arm: [0.5, 0.2], elbow: [0.6, 0.6] };
    Bp = {
      ...Bp,
      x: Bp.x + s * 0.28 + s * 0.2 * apart,
      lean: 0.04,
      arm: [0.5, 0.2],
      elbow: [0.6, 0.6],
    };
    peace = { x: lerp(W + s, fx + s * 0.05, k), walking: k < 1 };
  } else {
    // Cooling off: they turn away from each other.
    A = { ...A, x: A.x - s * 0.22, lean: 0.02, arm: [0.1, -0.05] };
    Bp = { ...Bp, x: Bp.x + s * 0.48, lean: 0.02, arm: [0.1, -0.05] };
    peace = fk < 15000 ? { x: fx + s * 0.05, walking: false } : null;
  }
  const fp = (o, base, face) =>
    standPose(o, T, face, {
      lean: base.lean,
      arm: base.arm,
      elbow: base.elbow,
      headTilt: base.tilt,
    });
  drawPerson(15, A.x, fy, s, fk >= 11500 ? -1 : 1, fp(geo.out.fighterA, A, 9));
  drawPerson(16, Bp.x, fy + s * 0.01, s * 0.98, fk >= 11500 ? 1 : -1, fp(geo.out.fighterB, Bp, 10));
  if (peace) {
    const peacePose = peace.walking
      ? walkPose((T * 0.006) % (Math.PI * 2), geo.out.peacemaker)
      : standPose(geo.out.peacemaker, T, 11, { arm: [1.5, -1.35], elbow: [0.05, 0.1], lean: 0.02 });
    drawPerson(17, peace.x, fy + s * 0.03, s, -1, peacePose);
  }
  if (impact && !still) {
    ctx.strokeStyle = SCHEME === "light" ? "rgba(255,255,255,0.9)" : "rgba(255,230,200,0.9)";
    ctx.lineWidth = 1.2;
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(impact[0] + Math.cos(a) * s * 0.03, impact[1] + Math.sin(a) * s * 0.03);
      ctx.lineTo(impact[0] + Math.cos(a) * s * 0.07, impact[1] + Math.sin(a) * s * 0.07);
      ctx.stroke();
    }
  }
  // Onlookers: one films on a phone, one points.
  const filmer = drawPerson(
    18,
    fx + s * 1.25,
    R.back,
    sb,
    -1,
    standPose(
      geo.out.filmer,
      T,
      12,
      watching ? { arm: [2.0, -0.1], elbow: [-0.3, 0.1], headTilt: -0.08 } : { arm: [0.1, -0.05] },
    ),
  );
  if (watching) {
    ctx.globalAlpha = 0.65;
    ctx.drawImage(
      spr.lamp,
      filmer.hand0[0] - s * 0.07,
      filmer.hand0[1] - s * 0.09,
      s * 0.14,
      s * 0.14,
    );
    ctx.globalAlpha = 1;
  }
  drawPerson(
    19,
    fx - s * 1.3,
    R.back,
    sb,
    1,
    standPose(
      geo.out.pointer,
      T,
      13,
      watching ? { arm: [1.6, 0.4], elbow: [0.05, 0.6], lean: 0.05 } : { arm: [0.1, -0.05] },
    ),
  );
  // When the scuffle starts, ask for a police car on the near lane.
  if (!still && fk >= 4300 && fk < 4400 && !geo.policeCalled) {
    geo.policeCalled = true;
    geo.policeDue = t;
  }
  if (fk < 4300) geo.policeCalled = false;

  // ── Traffic: simulated, random arrivals and speeds ────────────────────────────────────
  if (!still) {
    const dt = geo.lastT == null ? 16 : Math.max(0, Math.min(100, t - geo.lastT));
    stepTraffic(dt, t);
    geo.lastT = t;
  }
  for (const ln of geo.lanes) {
    for (const c of ln.cars) {
      const x = ln.dir > 0 ? c.pos : W - c.pos;
      vehicle(c.type, x, ln.y, ln.len, ln.dir, c.paint, t, still, c.spin);
    }
  }

  // Streetlamp glows at dusk.
  if (SCHEME !== "light")
    for (const lp of lamps) {
      ctx.globalAlpha = 0.85;
      ctx.drawImage(spr.lamp, lp.x - geo.s * 0.45, lp.y - geo.s * 0.35, geo.s * 0.9, geo.s * 0.9);
    }
  ctx.globalAlpha = 1;

  // A warm lift of light when a run finishes.
  const cheer = Math.max(0, 1 - (t - cheerAt) / 1600);
  if (cheer > 0) {
    ctx.globalAlpha = cheer * 0.25;
    ctx.fillStyle = rgba(L.glow, 1);
    ctx.fillRect(0, 0, W, H);
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
    if (name === "done" || name === "pr-merged") cheerAt = now;
  },
});
