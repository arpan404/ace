/*
 * Drop Zone's backdrop: a modern-warfare drop zone at dusk, drawn and animated in code.
 *
 * Far: a dramatic sky, a transport plane dropping paratroopers, a supply crate under a canopy
 * trailing red smoke. Middle: a ruined city with burning windows, smoke columns, embers, a
 * helicopter sweeping its searchlight and distant blasts that light the sky. Near: a rubble
 * ridge and three operators with jointed limbs: a kneeling marksman firing short bursts (recoil,
 * muzzle flash, tracers, brass), a rifleman scanning with his weight shifting, and a third
 * sprinting across behind them. All original. Light scheme: an overcast, foggy day.
 *
 * Static layers are painted once per size and scheme; each frame draws only what moves.
 */

const LOOK = {
  dark: {
    sky: [
      [0, "#0d1118"],
      [0.35, "#1b1d26"],
      [0.6, "#3d2c2a"],
      [0.78, "#7a4a32"],
      [0.9, "#b8693a"],
    ],
    glow: [255, 140, 70],
    cloud: [120, 80, 70],
    cloudLit: [255, 150, 90],
    city: ["#1a1716", "#141211", "#0e0d0c"],
    window: [255, 140, 60],
    fire: [255, 120, 40],
    ground: ["#14120f", "#0b0a09"],
    rubble: "#1e1b17",
    near: "#3a3a33",
    far: "#25251f",
    gear: "#4a4935",
    gear2: "#33332a",
    helmet: "#45453a",
    skin: "#3a2e26",
    rim: "rgba(255,150,80,0.95)",
    rimSoft: "rgba(255,190,130,0.5)",
    smoke: [104, 88, 78],
    smokeA: 0.5,
    ember: [255, 160, 70],
    tracer: [255, 220, 150],
    plane: "#16161a",
    chute: ["#2e2e28", "#5d5238"],
    crate: ["#7a3220", "#d0c4a8"],
    flare: [230, 60, 40],
    heli: "#121216",
    beam: [255, 240, 210],
    flash: [255, 170, 90],
  },
  light: {
    sky: [
      [0, "#8d99a3"],
      [0.45, "#b3bbc0"],
      [0.75, "#cfd1cc"],
      [0.9, "#ddd8cc"],
    ],
    glow: [255, 235, 200],
    cloud: [150, 156, 160],
    cloudLit: [235, 235, 230],
    city: ["#9da1a0", "#8c908e", "#7b7f7c"],
    window: [255, 170, 100],
    fire: [255, 130, 60],
    ground: ["#8a8577", "#6f6b60"],
    rubble: "#97917f",
    near: "#5e5f58",
    far: "#4a4b45",
    gear: "#6e6d58",
    gear2: "#5f5e4c",
    helmet: "#66665a",
    skin: "#7a6656",
    rim: "rgba(255,250,235,0.85)",
    rimSoft: "rgba(255,255,255,0.45)",
    smoke: [110, 108, 104],
    smokeA: 0.45,
    ember: [255, 180, 110],
    tracer: [255, 230, 170],
    plane: "#555a5f",
    chute: ["#7d7d6a", "#a49770"],
    crate: ["#a24a30", "#ece4d2"],
    flare: [235, 80, 60],
    heli: "#4f545a",
    beam: [255, 255, 240],
    flash: [255, 220, 170],
  },
};

const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
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

/* ── The operator rig ────────────────────────────────────────────────────────────────────
   Figure units: 1 = standing height, feet on y = 0, x = 0 under the hip, facing +x (mirrored
   on screen when facing left). Angles are radians from straight down, positive toward the
   facing side. Joints come from forward kinematics; hands reach the rifle (or a pouch, or a
   raised fist) by two-bone IK. Each figure is painted into its own canvas with camouflage,
   gear and a detailed rifle, lit (warm side, shadow side), and composited over a rim pass. */

const LEN = { thigh: 0.25, shin: 0.24, torso: 0.33, neck: 0.1, upper: 0.17, fore: 0.165 };
const at = (p, a, l) => [p[0] + Math.sin(a) * l, p[1] + Math.cos(a) * l];
const lerp = (a, b, k) => a + (b - a) * k;
const ease = (k) => (k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k));
const mix2 = (p, q, k) => [lerp(p[0], q[0], k), lerp(p[1], q[1], k)];

function ik(sh, target, a, b, bendSign) {
  const dx = target[0] - sh[0],
    dy = target[1] - sh[1];
  const d = Math.min(a + b - 1e-4, Math.max(Math.abs(a - b) + 1e-4, Math.hypot(dx, dy)));
  const base = Math.atan2(dy, dx);
  const ang = Math.acos((a * a + d * d - b * b) / (2 * a * d));
  const e = base + bendSign * ang;
  const elbow = [sh[0] + Math.cos(e) * a, sh[1] + Math.sin(e) * a];
  const k = Math.min(1, (a + b - 1e-4) / Math.hypot(dx, dy || 1e-6));
  const hand = Math.hypot(dx, dy) > a + b ? [sh[0] + dx * k, sh[1] + dy * k] : target;
  return { elbow, hand };
}

const runLeg = (q) => ({
  hip: 0.12 + 0.32 * Math.sin(q),
  knee: 0.45 + 0.4 * Math.pow(Math.max(0, Math.cos(q)), 1.5),
});

function pose(kind, t, phase) {
  if (kind === "run") {
    // Tactical advance: low, knees always bent, short heel-to-toe steps, hips level,
    // rifle shouldered and level, head steady behind the optic.
    const p = phase;
    return {
      hipHeight: 0.497 + 0.005 * Math.cos(p * 2),
      lean: 0.16,
      bob: 0,
      head: 0.02,
      legs: [runLeg(p), runLeg(p + Math.PI)],
      gun: { off: [0.015, 0.035], ang: Math.PI / 2 - 0.03 + Math.sin(p * 2) * 0.006 },
    };
  }
  if (kind === "kneel") {
    return {
      lean: 0.14 + Math.sin(t * 0.0012) * 0.008,
      bob: Math.sin(t * 0.0012) * 0.004,
      head: 0.12,
      legs: [
        { hip: Math.PI / 2 - 0.08, knee: Math.PI / 2 - 0.08 },
        { hip: -0.22, knee: 1.38 },
      ],
      gun: { off: [0.015, 0.035], ang: Math.PI / 2 - 0.02 + Math.sin(t * 0.0011) * 0.008 },
    };
  }
  // Rifleman: planted stance, breathing, a slow sweep with the head following the rifle.
  const sweep = Math.sin(t * 0.0003);
  return {
    lean: 0.06,
    bob: Math.sin(t * 0.0012) * 0.003,
    head: sweep * 0.12,
    legs: [
      { hip: 0.14, knee: 0.12 },
      { hip: -0.16, knee: 0.14 },
    ],
    gun: { off: [0.035, 0.06], ang: Math.PI / 2 - 0.3 + sweep * 0.08 },
  };
}

function solve(P) {
  const hip = [0, -0.5 + P.bob];
  const up = [Math.sin(P.lean), -Math.cos(P.lean)];
  const neck = [hip[0] + up[0] * LEN.torso, hip[1] + up[1] * LEN.torso];
  const head = [
    neck[0] + Math.sin(P.lean * 0.6) * LEN.neck,
    neck[1] - Math.cos(P.lean * 0.6) * LEN.neck,
  ];
  const shoulder = [neck[0] - up[0] * 0.035, neck[1] - up[1] * 0.035];
  const legs = P.legs.map((l) => {
    const knee = at(hip, l.hip, LEN.thigh);
    const shinA = l.hip - l.knee;
    const ankle = at(knee, shinA, LEN.shin);
    return { knee, ankle, shinA };
  });
  const stock = [shoulder[0] + P.gun.off[0], shoulder[1] + P.gun.off[1]];
  const dir = [Math.sin(P.gun.ang), Math.cos(P.gun.ang)];
  const along = (k, o = 0) => [
    stock[0] + dir[0] * k - dir[1] * o,
    stock[1] + dir[1] * k + dir[0] * o,
  ];
  const grip = along(0.12, 0.045),
    fore = along(0.3, 0.03);
  const R = ik(shoulder, grip, LEN.upper, LEN.fore, 1);
  const leftSh = [shoulder[0] + 0.02, shoulder[1] - 0.01];
  const Lh = ik(leftSh, P.leftHand || fore, LEN.upper, LEN.fore, P.leftBend || 1);
  let low = -1;
  for (const l of legs) low = Math.max(low, l.ankle[1] + 0.035, l.knee[1] + 0.05);
  if (P.hipHeight != null) low = P.hipHeight - 0.5 + P.bob;
  return {
    hip,
    up,
    neck,
    head,
    shoulder,
    leftSh,
    legs,
    stock,
    dir,
    along,
    grip,
    fore,
    R,
    Lh,
    lift: -low,
    P,
  };
}

function camoPattern(g, rnd, dark) {
  const { c, g: pg } = makeCanvas(160, 160, 1);
  const base = dark
    ? ["#6f6449", "#5a523b", "#857a5a", "#46503a", "#9a8d6a"]
    : ["#8d8466", "#766e55", "#a39a7a", "#5f6a50", "#b5ab8a"];
  pg.fillStyle = base[0];
  pg.fillRect(0, 0, 160, 160);
  for (let i = 0; i < 70; i++) {
    pg.fillStyle = base[1 + ((rnd() * 4) | 0)];
    const x = rnd() * 160,
      y = rnd() * 160,
      r = 6 + rnd() * 16;
    pg.beginPath();
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2,
        rr = r * (0.6 + rnd() * 0.6);
      if (k) pg.lineTo(x + Math.cos(a) * rr * 1.6, y + Math.sin(a) * rr);
      else pg.moveTo(x + Math.cos(a) * rr * 1.6, y + Math.sin(a) * rr);
    }
    pg.closePath();
    pg.fill();
  }
  const pat = g.createPattern(c, "repeat");
  return pat;
}

/** Paint one operator into its own canvas (device px), then rim + composite onto ctx. */
function operator(dst, sx, sy, s, facing, J, F) {
  const fg = F.g,
    pr = PR;
  const cw = F.c.width,
    ch = F.c.height;
  fg.setTransform(1, 0, 0, 1, 0, 0);
  fg.globalCompositeOperation = "source-over";
  fg.clearRect(0, 0, cw, ch);
  const ox = cw / 2,
    oy = ch - 0.06 * s * pr;
  fg.setTransform(pr * s * facing, 0, 0, pr * s, ox, oy);
  const Lk = L;
  const camo = F.camo;
  camo.setTransform(new DOMMatrix().scale(0.0024 * facing, 0.0024));
  const lift = J.lift;
  const P = (p) => [p[0], p[1] + lift];
  const path = (pts) => {
    fg.beginPath();
    pts.forEach((p, i) => {
      const q = P(p);
      if (i) fg.lineTo(q[0], q[1]);
      else fg.moveTo(q[0], q[1]);
    });
    fg.closePath();
  };
  const taper = (a, b, wa, wb, fill) => {
    const A = P(a),
      B = P(b);
    const th = Math.atan2(B[1] - A[1], B[0] - A[0]);
    fg.beginPath();
    fg.arc(B[0], B[1], wb, th - Math.PI / 2, th + Math.PI / 2);
    fg.arc(A[0], A[1], wa, th + Math.PI / 2, th + Math.PI * 1.5);
    fg.closePath();
    fg.fillStyle = fill;
    fg.fill();
  };
  const ell = (p, rx, ry, rot, fill) => {
    const q = P(p);
    fg.beginPath();
    fg.ellipse(q[0], q[1], rx, ry, rot, 0, Math.PI * 2);
    fg.fillStyle = fill;
    fg.fill();
  };
  const tq = (u, v) => [
    J.hip[0] + Math.cos(J.P.lean) * u + J.up[0] * v,
    J.hip[1] + Math.sin(J.P.lean) * u + J.up[1] * v,
  ];
  const coyote = "#6e624a",
    coyoteD = "#574d3a",
    black = "#141414",
    glove = "#2a2622",
    fde = "#7a6c52";
  const [near, far] = J.legs;

  const boot = (l, shade) => {
    const a = l.ankle,
      r = l.shinA * 0.35;
    const pts = [
      [-0.03, -0.035],
      [0.035, -0.03],
      [0.09, -0.005],
      [0.095, 0.03],
      [-0.035, 0.03],
    ].map(([u, v]) => [
      a[0] + u * Math.cos(r) - v * Math.sin(r),
      a[1] + u * Math.sin(r) + v * Math.cos(r),
    ]);
    path(pts);
    fg.fillStyle = shade ? "#221f1b" : "#2e2a24";
    fg.fill();
  };
  const leg = (l, dark) => {
    taper(J.hip, l.knee, 0.062, 0.047, camo);
    taper(l.knee, l.ankle, 0.046, 0.034, camo);
    if (dark) {
      taper(J.hip, l.knee, 0.062, 0.047, "rgba(0,0,0,0.35)");
      taper(l.knee, l.ankle, 0.046, 0.034, "rgba(0,0,0,0.35)");
    }
    const mid = mix2(J.hip, l.knee, 0.55);
    const th = Math.atan2(l.knee[1] - J.hip[1], l.knee[0] - J.hip[0]);
    ell(mid, 0.05, 0.034, th, "rgba(0,0,0,0.18)"); // cargo pocket
    ell(l.knee, 0.042, 0.036, th, dark ? "#2c2922" : "#3a362d"); // knee pad
    boot(l, dark);
  };
  const arm = (sh, R, dark) => {
    taper(sh, R.elbow, 0.042, 0.035, camo);
    taper(R.elbow, R.hand, 0.034, 0.028, camo);
    if (dark) {
      taper(sh, R.elbow, 0.042, 0.035, "rgba(0,0,0,0.35)");
      taper(R.elbow, R.hand, 0.034, 0.028, "rgba(0,0,0,0.35)");
    }
    ell(R.hand, 0.031, 0.028, 0, glove);
  };
  const gunAt = (k, o) => P(J.along(k, o));
  const poly = (pts, col) => {
    fg.beginPath();
    pts.forEach(([k, o], i) => {
      const q = gunAt(k, o);
      if (i) fg.lineTo(q[0], q[1]);
      else fg.moveTo(q[0], q[1]);
    });
    fg.closePath();
    fg.fillStyle = col;
    fg.fill();
  };
  const rifle = () => {
    poly(
      [
        [-0.05, -0.02],
        [0.05, -0.02],
        [0.06, 0.035],
        [-0.03, 0.06],
        [-0.055, 0.05],
      ],
      fde,
    ); // stock
    poly(
      [
        [0.04, -0.022],
        [0.2, -0.025],
        [0.2, 0.02],
        [0.05, 0.022],
      ],
      black,
    ); // receiver
    poly(
      [
        [0.11, 0.02],
        [0.14, 0.02],
        [0.13, 0.075],
        [0.105, 0.072],
      ],
      black,
    ); // grip
    poly(
      [
        [0.16, 0.02],
        [0.2, 0.02],
        [0.225, 0.085],
        [0.19, 0.092],
      ],
      "#1c1c1b",
    ); // curved mag
    poly(
      [
        [0.2, -0.022],
        [0.37, -0.02],
        [0.37, 0.022],
        [0.2, 0.025],
      ],
      fde,
    ); // handguard
    for (let k = 0.21; k < 0.36; k += 0.025)
      poly(
        [
          [k, -0.024],
          [k + 0.012, -0.024],
          [k + 0.012, -0.018],
          [k, -0.018],
        ],
        black,
      );
    poly(
      [
        [0.29, 0.022],
        [0.31, 0.022],
        [0.305, 0.065],
        [0.29, 0.065],
      ],
      black,
    ); // foregrip
    poly(
      [
        [0.37, -0.016],
        [0.5, -0.016],
        [0.5, 0.016],
        [0.37, 0.016],
      ],
      "#1a1a19",
    ); // suppressor
    poly(
      [
        [0.08, -0.03],
        [0.1, -0.05],
        [0.22, -0.05],
        [0.24, -0.03],
      ],
      black,
    ); // scope
    poly(
      [
        [0.06, -0.035],
        [0.08, -0.06],
        [0.1, -0.06],
        [0.1, -0.03],
      ],
      black,
    ); // eyepiece bell
    poly(
      [
        [0.22, -0.03],
        [0.24, -0.062],
        [0.27, -0.062],
        [0.27, -0.03],
      ],
      black,
    ); // objective bell
  };
  const torso = (dark) => {
    path([
      tq(-0.075, 0),
      tq(0.075, 0),
      tq(0.1, 0.22),
      tq(0.095, 0.33),
      tq(-0.095, 0.33),
      tq(-0.1, 0.2),
    ]);
    fg.fillStyle = camo;
    fg.fill();
    if (dark) {
      fg.fillStyle = "rgba(0,0,0,0.2)";
      fg.fill();
    }
    path([tq(-0.088, 0.1), tq(0.098, 0.1), tq(0.103, 0.31), tq(-0.09, 0.31)]); // plate carrier
    fg.fillStyle = coyote;
    fg.fill();
    for (let k = 0; k < 3; k++) {
      path([
        tq(0.095, 0.11 + k * 0.045),
        tq(0.135, 0.11 + k * 0.045),
        tq(0.135, 0.148 + k * 0.045),
        tq(0.095, 0.148 + k * 0.045),
      ]);
      fg.fillStyle = k % 2 ? coyoteD : "#62574a";
      fg.fill();
    }
    path([tq(0.07, 0.22), tq(0.12, 0.22), tq(0.12, 0.29), tq(0.07, 0.29)]); // admin pouch
    fg.fillStyle = coyoteD;
    fg.fill();
    fg.strokeStyle = "rgba(0,0,0,0.35)";
    fg.lineWidth = 0.006;
    for (let k = 0.13; k < 0.3; k += 0.03) {
      const a = P(tq(-0.085, k)),
        b = P(tq(0.06, k));
      fg.beginPath();
      fg.moveTo(a[0], a[1]);
      fg.lineTo(b[0], b[1]);
      fg.stroke();
    }
  };
  const pack = () => {
    path([tq(-0.08, 0.08), tq(-0.2, 0.1), tq(-0.215, 0.32), tq(-0.08, 0.35)]);
    fg.fillStyle = coyoteD;
    fg.fill();
    fg.strokeStyle = "rgba(0,0,0,0.3)";
    fg.lineWidth = 0.006;
    for (let k = 0.14; k < 0.32; k += 0.035) {
      const a = P(tq(-0.2, k)),
        b = P(tq(-0.09, k + 0.01));
      fg.beginPath();
      fg.moveTo(a[0], a[1]);
      fg.lineTo(b[0], b[1]);
      fg.stroke();
    }
  };
  const head = () => {
    const h = P(J.head);
    fg.save();
    fg.translate(h[0], h[1]);
    fg.rotate(J.P.lean * 0.5 + J.P.head * 0.35);
    fg.fillStyle = "#26231f"; // balaclava
    fg.beginPath();
    fg.ellipse(0.012, 0.012, 0.047, 0.057, 0, 0, Math.PI * 2);
    fg.fill();
    fg.fillStyle = "#57503f"; // ballistic helmet
    fg.beginPath();
    fg.moveTo(-0.072, 0.01);
    fg.quadraticCurveTo(-0.08, -0.07, 0.0, -0.075);
    fg.quadraticCurveTo(0.07, -0.072, 0.074, -0.01);
    fg.lineTo(0.055, -0.004);
    fg.lineTo(0.045, 0.016);
    fg.lineTo(-0.03, 0.02);
    fg.lineTo(-0.045, 0.032);
    fg.closePath();
    fg.fill();
    fg.fillStyle = "rgba(0,0,0,0.3)";
    fg.fillRect(-0.06, -0.012, 0.11, 0.01); // side rail
    fg.fillStyle = "#1d1c1a";
    fg.fillRect(0.05, -0.062, 0.035, 0.03); // NVG shroud and mount
    fg.fillRect(0.075, -0.05, 0.035, 0.016);
    fg.beginPath();
    fg.ellipse(-0.012, 0.014, 0.03, 0.034, 0, 0, Math.PI * 2); // comms headset
    fg.fill();
    fg.fillStyle = "#0b0b0b"; // eyewear
    fg.fillRect(0.015, 0.006, 0.045, 0.016);
    fg.fillStyle = "rgba(255,190,120,0.55)";
    fg.fillRect(0.03, 0.008, 0.025, 0.004);
    fg.restore();
  };

  leg(far, true);
  arm(J.leftSh, J.Lh, true);
  pack();
  torso(false);
  leg(near, false);
  head();
  rifle();
  arm(J.shoulder, J.R, false);

  // Light: warm from the left (fires, low sun), falling into shadow on the right.
  fg.setTransform(1, 0, 0, 1, 0, 0);
  fg.globalCompositeOperation = "source-atop";
  const lg = fg.createLinearGradient(0, 0, cw, 0);
  if (SCHEME === "light") {
    lg.addColorStop(0, "rgba(255,250,235,0.18)");
    lg.addColorStop(1, "rgba(30,30,28,0.25)");
  } else {
    lg.addColorStop(0, "rgba(255,150,80,0.22)");
    lg.addColorStop(0.5, "rgba(20,16,14,0.35)");
    lg.addColorStop(1, "rgba(8,8,10,0.62)");
  }
  fg.fillStyle = lg;
  fg.fillRect(0, 0, cw, ch);
  const vg = fg.createLinearGradient(0, 0, 0, ch);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, SCHEME === "light" ? "rgba(40,38,30,0.2)" : "rgba(0,0,0,0.35)");
  fg.fillStyle = vg;
  fg.fillRect(0, 0, cw, ch);

  // Rim pass: the silhouette in rim light, nudged toward the light, under the figure.
  const rg = F.rim.getContext("2d");
  rg.setTransform(1, 0, 0, 1, 0, 0);
  rg.globalCompositeOperation = "source-over";
  rg.clearRect(0, 0, cw, ch);
  rg.drawImage(F.c, 0, 0);
  rg.globalCompositeOperation = "source-in";
  rg.fillStyle = Lk.rim;
  rg.fillRect(0, 0, cw, ch);
  const left = sx - ox / pr,
    top = sy - oy / pr;
  const rd = Math.max(1.3, s * 0.007);
  dst.drawImage(F.rim, left - rd, top - rd * 0.4, cw / pr, ch / pr);
  dst.drawImage(F.c, left, top, cw / pr, ch / pr);
  const toScreen = (p) => [sx + facing * p[0] * s, sy + (p[1] + lift) * s];
  return {
    muzzle: toScreen(J.along(0.5, 0)),
    lens: toScreen(J.along(0.255, -0.046)),
    eject: toScreen(J.along(0.15, -0.02)),
    magwell: toScreen(J.along(0.18, 0.05)),
    dir: [facing * J.dir[0], J.dir[1]],
  };
}

function figureCanvas(s, rnd) {
  const w = s * 1.5,
    h = s * 1.2;
  const F = makeCanvas(w, h, PR);
  F.g.setTransform(1, 0, 0, 1, 0, 0);
  F.rim = makeCanvas(w, h, PR).c;
  F.camo = camoPattern(F.g, rnd, SCHEME !== "light");
  return F;
}

/* ── Scene state ────────────────────────────────────────────────────────────────────────── */

let ctx, W, H, PR, SCHEME, L;
let back, city, front;
let spr = {};
let smoke = [],
  embers = [],
  troopers = [],
  fires = [],
  flares = [],
  tracers = [],
  brass = [];
let geo = {};
let now = 0,
  cheerAt = -Infinity;

function build(view) {
  W = view.width;
  H = view.height;
  PR = view.pixelRatio;
  SCHEME = view.scheme;
  L = LOOK[SCHEME === "light" ? "light" : "dark"];
  const rnd = seeded(2042);
  const horizon = H * 0.62;
  geo = { horizon };

  // Sky with the low sun's glow.
  const B = makeCanvas(W, H, PR);
  back = B.c;
  const g = B.g;
  const sky = g.createLinearGradient(0, 0, 0, horizon);
  L.sky.forEach(([t, c]) => sky.addColorStop(t, c));
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);
  const sun = g.createRadialGradient(W * 0.68, horizon, 0, W * 0.68, horizon, Math.max(W, H) * 0.6);
  sun.addColorStop(0, rgba(L.glow, 0.55));
  sun.addColorStop(0.3, rgba(L.glow, 0.15));
  sun.addColorStop(1, rgba(L.glow, 0));
  g.fillStyle = sun;
  g.fillRect(0, 0, W, H);
  // Layered cloud banks, lit from below.
  for (let i = 0; i < 140; i++) {
    const cx = rnd() * W,
      cy = H * (0.05 + Math.pow(rnd(), 1.4) * 0.42),
      r = H * (0.03 + rnd() * 0.07);
    const lit = Math.max(0, cy / horizon - 0.35) * 1.2;
    const col = [0, 1, 2].map((k) =>
      Math.round(L.cloud[k] + (L.cloudLit[k] - L.cloud[k]) * Math.min(1, lit)),
    );
    const gr = g.createRadialGradient(cx, cy, 0, cx, cy, r);
    gr.addColorStop(0, rgba(col, 0.16));
    gr.addColorStop(1, rgba(col, 0));
    g.fillStyle = gr;
    g.beginPath();
    g.ellipse(cx, cy, r * 2.4, r * 0.7, 0, 0, Math.PI * 2);
    g.fill();
  }

  // The ruined city: three depths, broken tops, girders, dark and burning windows.
  const Cc = makeCanvas(W, H, PR);
  city = Cc.c;
  const c = Cc.g;
  fires = [];
  L.city.forEach((col, depth) => {
    let x = -20;
    const base = horizon + depth * H * 0.035;
    while (x < W + 20) {
      const w = 40 + rnd() * (90 - depth * 15);
      const h = H * (0.07 + rnd() * (0.15 - depth * 0.03));
      const top = base - h;
      c.fillStyle = col;
      c.beginPath();
      c.moveTo(x, H);
      c.lineTo(x, top + rnd() * 10);
      // Broken roofline.
      const steps = 4 + ((rnd() * 4) | 0);
      for (let i = 1; i <= steps; i++)
        c.lineTo(x + (w * i) / steps, top + (rnd() < 0.5 ? rnd() * h * 0.25 : rnd() * 8));
      c.lineTo(x + w, H);
      c.closePath();
      c.fill();
      // Girders sticking out of the break.
      if (rnd() < 0.5) {
        c.strokeStyle = col;
        c.lineWidth = 2;
        for (let k = 0; k < 3; k++) {
          const gx = x + w * (0.2 + rnd() * 0.6);
          c.beginPath();
          c.moveTo(gx, top + 10);
          c.lineTo(gx + (rnd() - 0.5) * 16, top - 8 - rnd() * 18);
          c.stroke();
        }
      }
      // Windows: mostly dark holes, a few burning.
      const shade = depth === 0 ? "rgba(0,0,0,0.35)" : "rgba(0,0,0,0.45)";
      for (let wy = top + 18; wy < H - 10; wy += 13)
        for (let wx = x + 6; wx < x + w - 8; wx += 11) {
          if (rnd() < 0.55) continue;
          c.fillStyle = shade;
          c.fillRect(wx, wy, 5, 7);
          if (rnd() < 0.018 && wy < base - 10)
            fires.push({ x: wx + 2.5, y: wy + 3.5, p: rnd() * 6, d: depth });
        }
      x += w + rnd() * 10;
    }
  });

  // Near ground: a rubble ridge across the bottom.
  const F = makeCanvas(W, H, PR);
  front = F.c;
  const f = F.g;
  const ridge = (x) => H * 0.88 - Math.sin((x / W) * 2.6 + 0.6) * H * 0.03 - (x / W) * H * 0.02;
  geo.ridge = ridge;
  const gg = f.createLinearGradient(0, H * 0.8, 0, H);
  gg.addColorStop(0, L.ground[0]);
  gg.addColorStop(1, L.ground[1]);
  f.fillStyle = gg;
  f.beginPath();
  f.moveTo(0, H);
  for (let x = 0; x <= W; x += 6) f.lineTo(x, ridge(x) + (rnd() - 0.5) * 3);
  f.lineTo(W, H);
  f.closePath();
  f.fill();
  f.fillStyle = L.rubble;
  for (let i = 0; i < 70; i++) {
    const x = rnd() * W,
      y = ridge(x) - 2 + rnd() * 6,
      w = 6 + rnd() * 26,
      h = 4 + rnd() * 12;
    f.beginPath();
    f.moveTo(x, y);
    f.lineTo(x + w * 0.3, y - h);
    f.lineTo(x + w, y - h * 0.4);
    f.lineTo(x + w * 0.9, y + 2);
    f.closePath();
    f.fill();
  }
  f.strokeStyle = L.rubble;
  f.lineWidth = 1.5;
  for (let i = 0; i < 16; i++) {
    const x = rnd() * W,
      y = ridge(x);
    f.beginPath();
    f.moveTo(x, y);
    f.lineTo(x + (rnd() - 0.5) * 30, y - 10 - rnd() * 22);
    f.stroke();
  }

  // Sprites and particles.
  spr = {
    smoke: sprite(L.smoke, L.smokeA, 0.5),
    fire: sprite(L.fire, 0.9),
    ember: sprite(L.ember, 1),
    flash: sprite(L.flash, 1),
    tracer: sprite(L.tracer, 1),
    flare: sprite(L.flare, 0.5, 0.5),
    beam: sprite(L.beam, 0.9),
  };
  const columns = [W * 0.47, W * 0.63, W * 0.86].map((x) => ({ x, y: horizon - H * 0.09 }));
  geo.columns = columns;
  smoke = Array.from({ length: 72 }, (_, i) => ({ col: i % 3, p: rnd(), s: rnd(), w: rnd() }));
  embers = Array.from({ length: 50 }, () => ({
    col: (rnd() * 3) | 0,
    p: rnd(),
    s: rnd(),
    w: rnd(),
  }));
  troopers = Array.from({ length: 5 }, (_, i) => ({ k: i, sway: rnd() * 6 }));
  flares = Array.from({ length: 40 }, (_, i) => ({ p: i / 40, s: rnd() }));
  // Five clouds were drawn from the seed here and never shown; the draws stay so every
  // seeded thing after them lands where it was designed.
  for (let i = 0; i < 20; i++) rnd();
  tracers = [];
  brass = [];

  const s = Math.max(140, Math.min(340, H * 0.34, W * 0.2));
  geo.s = s;
  const frnd = seeded(7);
  geo.figs = {
    kneel: figureCanvas(s, frnd),
    scan: figureCanvas(s, frnd),
    run: figureCanvas(s * 0.74, frnd),
  };
  geo.mags = [];
  geo.puffs = [];
  // Film grain: three noise tiles, cycled each frame.
  geo.grain = [0, 1, 2].map(() => {
    const { c: gc, g: gg2 } = makeCanvas(192, 192, 1);
    const img = gg2.createImageData(192, 192);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = rnd() < 0.5 ? 0 : 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = rnd() * (SCHEME === "light" ? 14 : 22);
    }
    gg2.putImageData(img, 0, 0);
    return ctx.createPattern(gc, "repeat");
  });
  // Vignette and sun rays with a lens flare.
  const V = makeCanvas(W, H, PR);
  geo.vignette = V.c;
  const vg = V.g.createRadialGradient(
    W * 0.6,
    H * 0.5,
    Math.min(W, H) * 0.35,
    W * 0.6,
    H * 0.5,
    Math.max(W, H) * 0.8,
  );
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, SCHEME === "light" ? "rgba(40,38,30,0.25)" : "rgba(0,0,0,0.55)");
  V.g.fillStyle = vg;
  V.g.fillRect(0, 0, W, H);
  const sunX = W * 0.68,
    sunY = horizon;
  g.globalCompositeOperation = "lighter";
  for (let i = 0; i < 9; i++) {
    const a = -Math.PI / 2 + (i - 4) * 0.22 + (rnd() - 0.5) * 0.1,
      len = H * (0.6 + rnd() * 0.4),
      w = 0.04 + rnd() * 0.05;
    const rg = g.createLinearGradient(
      sunX,
      sunY,
      sunX + Math.cos(a) * len,
      sunY + Math.sin(a) * len,
    );
    rg.addColorStop(0, rgba(L.glow, SCHEME === "light" ? 0.035 : 0.045));
    rg.addColorStop(1, rgba(L.glow, 0));
    g.fillStyle = rg;
    g.beginPath();
    g.moveTo(sunX, sunY);
    g.lineTo(sunX + Math.cos(a - w) * len, sunY + Math.sin(a - w) * len);
    g.lineTo(sunX + Math.cos(a + w) * len, sunY + Math.sin(a + w) * len);
    g.closePath();
    g.fill();
  }
  g.globalCompositeOperation = "source-over";
  geo.flare = [0.25, 0.45, 0.7, 0.9].map((k, i) => ({
    x: lerp(sunX, W * 0.4, k),
    y: lerp(sunY, H * 0.25, k),
    r: [26, 12, 40, 18][i],
  }));
  geo.kneel = { x: W - s * 1.35, y: ridge(W - s * 1.35) + 4 };
  geo.scan = { x: W - s * 0.5, y: ridge(W - s * 0.5) + 4 };
  geo.runY = H * 0.8;
}

function plane(x, y, k) {
  // Drawn nose-left, then mirrored so it flies nose-first to the right.
  ctx.save();
  ctx.translate(x, 0);
  ctx.scale(-1, 1);
  ctx.translate(-x, 0);
  ctx.fillStyle = L.plane;
  ctx.beginPath();
  ctx.ellipse(x, y, 36 * k, 6 * k, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x - 6 * k, y - 4 * k);
  ctx.lineTo(x + 4 * k, y - 28 * k);
  ctx.lineTo(x + 12 * k, y - 28 * k);
  ctx.lineTo(x + 12 * k, y - 4 * k);
  ctx.moveTo(x - 6 * k, y - 2 * k);
  ctx.lineTo(x + 2 * k, y + 20 * k);
  ctx.lineTo(x + 10 * k, y + 20 * k);
  ctx.lineTo(x + 12 * k, y - 2 * k);
  ctx.moveTo(x + 26 * k, y - 3 * k);
  ctx.lineTo(x + 40 * k, y - 17 * k);
  ctx.lineTo(x + 45 * k, y - 17 * k);
  ctx.lineTo(x + 38 * k, y + 1 * k);
  ctx.fill();
  for (const o of [-14, -6]) {
    ctx.fillRect(x + (o + 6) * k, y + (o < -10 ? -20 : -12) * k, 6 * k, 2.5 * k);
  }
  ctx.restore();
}

function chute(x, y, k, cols, crate) {
  ctx.fillStyle = cols[0];
  ctx.beginPath();
  ctx.moveTo(x - 16 * k, y);
  ctx.quadraticCurveTo(x - 15 * k, y - 13 * k, x, y - 14 * k);
  ctx.quadraticCurveTo(x + 15 * k, y - 13 * k, x + 16 * k, y);
  ctx.quadraticCurveTo(x, y - 4 * k, x - 16 * k, y);
  ctx.fill();
  ctx.fillStyle = cols[1];
  for (const o of [-8, 3]) ctx.fillRect(x + o * k, y - 12.5 * k, 5 * k, 9.5 * k);
  ctx.strokeStyle = cols[0];
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  ctx.moveTo(x - 15 * k, y);
  ctx.lineTo(x, y + 16 * k);
  ctx.lineTo(x + 15 * k, y);
  ctx.stroke();
  if (crate) {
    ctx.fillStyle = L.crate[0];
    ctx.fillRect(x - 6 * k, y + 15 * k, 12 * k, 9 * k);
    ctx.fillStyle = L.crate[1];
    ctx.fillRect(x - 6 * k, y + 18.5 * k, 12 * k, 1.6 * k);
  } else {
    ctx.fillStyle = L.plane;
    ctx.beginPath();
    ctx.arc(x, y + 14.5 * k, 1.5 * k, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(x - 1.3 * k, y + 15.5 * k, 2.6 * k, 5.5 * k);
    ctx.fillRect(x - 2.4 * k, y + 16.5 * k, 4.8 * k, 1.1 * k);
  }
}

function helicopter(x, y, k, t, still) {
  // Searchlight first, under the body.
  const sweep = still ? 0.2 : Math.sin(t * 0.0005) * 0.5;
  const bx = x + Math.sin(sweep) * H * 0.5,
    by = geo.horizon + H * 0.05;
  const beam = ctx.createLinearGradient(x, y, bx, by);
  beam.addColorStop(0, rgba(L.beam, SCHEME === "light" ? 0.12 : 0.22));
  beam.addColorStop(1, rgba(L.beam, 0));
  ctx.fillStyle = beam;
  ctx.beginPath();
  ctx.moveTo(x - 3 * k, y + 4 * k);
  ctx.lineTo(bx - 40 * k, by);
  ctx.lineTo(bx + 40 * k, by);
  ctx.lineTo(x + 3 * k, y + 4 * k);
  ctx.fill();
  // The body is drawn nose-left; mirror it when flying right, and pitch the nose down.
  const vx = still ? -1 : Math.cos(t * 0.00006);
  const dir = vx >= 0 ? 1 : -1;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(-dir, 1);
  ctx.rotate(-0.08 * Math.min(1, Math.abs(vx) * 3));
  ctx.translate(-x, -y);
  ctx.fillStyle = L.heli;
  ctx.beginPath();
  ctx.ellipse(x, y, 16 * k, 7 * k, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(x + 8 * k, y - 2.5 * k, 28 * k, 3.5 * k);
  ctx.fillRect(x + 33 * k, y - 9 * k, 3 * k, 9 * k);
  ctx.fillRect(x - 6 * k, y + 7 * k, 18 * k, 1.2 * k);
  ctx.fillRect(x - 1 * k, y - 10 * k, 2 * k, 4 * k);
  // Rotor: a faint disc and two fast blades.
  ctx.strokeStyle = L.heli;
  ctx.globalAlpha = 0.35;
  ctx.beginPath();
  ctx.ellipse(x, y - 10 * k, 30 * k, 2.4 * k, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 0.9;
  const a = still ? 0.4 : t * 0.05;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x - Math.cos(a) * 30 * k, y - 10 * k);
  ctx.lineTo(x + Math.cos(a) * 30 * k, y - 10 * k);
  ctx.stroke();
  ctx.globalAlpha = 1;
  const blink = still ? 1 : t % 1200 < 140;
  if (blink) ctx.drawImage(spr.flare, x + 30 * k, y - 16 * k, 12 * k, 12 * k);
  ctx.restore();
}

function draw(t, still) {
  ctx.setTransform(PR, 0, 0, PR, 0, 0);
  ctx.drawImage(back, 0, 0, W, H);
  const horizon = geo.horizon;

  // Distant blasts behind the city every ~11 s: a flash that lights the sky, then a fireball.
  const blastCycle = 11000,
    bk = t % blastCycle,
    blastX = W * (0.35 + ((Math.floor(t / blastCycle) * 0.37) % 0.5));
  if (!still && bk < 2400) {
    const k = bk / 2400;
    ctx.globalAlpha = Math.max(0, 1 - k * 1.6) * 0.8;
    ctx.drawImage(spr.flash, blastX - H * 0.4, horizon - H * 0.35, H * 0.8, H * 0.6);
    ctx.globalAlpha = Math.max(0, 1 - k) * 0.9;
    const r = H * (0.03 + k * 0.06);
    ctx.drawImage(spr.fire, blastX - r, horizon - H * 0.06 - k * H * 0.08 - r, r * 2, r * 2);
    ctx.globalAlpha = 1;
  }

  // The plane and paratroopers (PUBG), every 45 s.
  const cycle = 45000,
    pk = t % cycle,
    span = W + 320;
  const px = still ? W * 0.55 : -160 + (pk / cycle) * span,
    py = H * 0.12;
  const trail = ctx.createLinearGradient(px - 40, 0, px - 40 - W * 0.3, 0);
  trail.addColorStop(0, rgba(L.tracer, 0.35));
  trail.addColorStop(1, rgba(L.tracer, 0));
  ctx.fillStyle = trail;
  ctx.fillRect(px - 40 - W * 0.3, py - 1, W * 0.3, 1.4);
  ctx.fillRect(px - 40 - W * 0.27, py + 5, W * 0.27, 1.1);
  plane(px, py, Math.max(0.9, W / 1400));
  for (const tr of troopers) {
    const leave = 9000 + tr.k * 2400;
    const age = still ? 15000 - tr.k * 1700 : (t - leave + cycle) % cycle;
    if (age > 28000) continue;
    const x0 = -160 + (leave / cycle) * span;
    const x = x0 + age * 0.004 + Math.sin(t * 0.0012 + tr.sway) * 6;
    const y = py + 30 + Math.min(1, age / 28000) * H * 0.4;
    chute(x, y, Math.max(0.8, W / 1600), L.chute, false);
  }
  // Supply crate under its canopy, trailing red smoke.
  const dk = still ? 13000 : t % 32000;
  const cx = W * 0.4 + Math.sin(t * 0.0008) * 10,
    cy = H * 0.1 + (dk / 32000) * H * 0.42;
  for (const fl of flares) {
    const life = still ? fl.p : (fl.p + t * 0.0004) % 1;
    const r = 3 + life * 18;
    ctx.globalAlpha = (1 - life) * 0.5;
    ctx.drawImage(
      spr.flare,
      cx - r + life * 40 + Math.sin(life * 8 + fl.s * 6) * 5,
      cy + 18 - life * 70 - r,
      r * 2,
      r * 2,
    );
  }
  ctx.globalAlpha = 1;
  chute(cx, cy, Math.max(1.4, W / 900), [L.crate[0], L.crate[1]], true);

  // The helicopter (CoD), drifting along the skyline.
  const hx = still ? W * 0.3 : W * (0.18 + 0.12 * Math.sin(t * 0.00006)),
    hy = H * 0.3 + Math.sin(t * 0.0009) * 4;
  helicopter(hx, hy, Math.max(0.9, W / 1300), t, still);

  ctx.drawImage(city, 0, 0, W, H);
  // Smoke columns rising from the ruins.
  for (const p of smoke) {
    const col = geo.columns[p.col];
    const life = still ? p.p : (p.p + t * 0.00004 * (0.8 + p.s * 0.4)) % 1;
    const r = H * (0.015 + life * 0.09);
    const x = col.x + life * W * 0.08 + Math.sin(life * 5 + p.w * 6) * 14;
    const y = col.y - life * H * 0.45;
    ctx.globalAlpha = Math.min(1, life * 6) * (1 - life);
    ctx.drawImage(spr.smoke, x - r, y - r, r * 2, r * 2);
  }
  ctx.globalAlpha = 1;

  // Burning windows flicker.
  for (const f of fires) {
    const a = still ? 0.8 : 0.55 + 0.45 * Math.sin(t * 0.012 + f.p) * Math.sin(t * 0.007 + f.p * 2);
    ctx.globalAlpha = Math.max(0.2, a) * (SCHEME === "light" ? 0.55 : 1);
    ctx.drawImage(spr.fire, f.x - 6, f.y - 6, 12, 12);
  }
  ctx.globalAlpha = 1;
  // Embers rising from the columns.
  if (!still)
    for (const e of embers) {
      const col = geo.columns[e.col];
      const life = (e.p + t * 0.00009 * (0.7 + e.s)) % 1;
      const x = col.x + (e.w - 0.5) * 60 + life * 60 + Math.sin(t * 0.003 + e.s * 9) * 6;
      const y = col.y + 10 - life * H * 0.32;
      ctx.globalAlpha = (1 - life) * 0.9;
      ctx.drawImage(spr.ember, x - 2, y - 2, 4, 4);
    }
  ctx.globalAlpha = 1;

  ctx.drawImage(front, 0, 0, W, H);

  // The operators.
  const s = geo.s;
  // Third operator: a tactical advance right to left behind the squad every 22 s.
  const rc = 22000,
    rk = t % rc,
    cross = 13000;
  if (!still && rk < cross) {
    const dist = (rk / cross) * (W + 160),
      rx = W + 80 - dist,
      rs = s * 0.74;
    // Stride matched to ground speed so the planted foot doesn't slide.
    const phase = (dist / (0.61 * rs)) * Math.PI * 2;
    const J = solve(pose("run", t, phase));
    operator(ctx, rx, geo.ridge(rx) - s * 0.06, rs, -1, J, geo.figs.run);
  }

  // Rifleman: sweeps the area; every 14 s raises a fist for "hold".
  const Ps = pose("scan", t);
  const sig = still ? 0 : ((t % 14000) - 9000) / 1800;
  if (sig > 0 && sig < 1) {
    const k = ease(Math.min(1, sig * 4)) * ease(Math.min(1, (1 - sig) * 4));
    Ps.gun.ang = lerp(Ps.gun.ang, Math.PI / 2 - 0.75, k);
    const J0 = solve(Ps);
    Ps.leftHand = mix2(J0.fore, [J0.head[0] + 0.04, J0.head[1] - 0.1], k);
    Ps.leftBend = -1;
    Ps.head = lerp(Ps.head, -0.1, k);
  }
  operator(ctx, geo.scan.x, geo.scan.y, s, -1, solve(Ps), geo.figs.scan);

  // Marksman: bursts every 3 s; every 18 s a full reload.
  const cyc = still ? 1500 : t % 18000;
  const Pk = pose("kneel", t);
  let firing = false,
    recoil = 0,
    shot = -1,
    reload = -1;
  if (cyc < 12000) {
    const b = cyc % 3000;
    firing = !still && b < 330;
    recoil = firing ? Math.max(0, 1 - (b % 110) / 70) : 0;
    shot = Math.floor(t / 110);
  } else if (cyc < 14800) {
    reload = (cyc - 12000) / 2800;
  }
  Pk.gun.off = [Pk.gun.off[0] - recoil * 0.025, Pk.gun.off[1] - recoil * 0.006];
  Pk.gun.ang -= recoil * 0.06;
  Pk.lean -= recoil * 0.03;
  if (reload >= 0) {
    // Dip the rifle, hand to the magazine, drop it, hand to the vest, seat a new one, back up.
    const dip = ease(Math.min(1, reload * 5)) * ease(Math.min(1, (1 - reload) * 5));
    Pk.gun.ang = lerp(Pk.gun.ang, Math.PI / 2 - 0.45, dip);
    Pk.gun.off = [Pk.gun.off[0], Pk.gun.off[1] + 0.05 * dip];
    const J0 = solve(Pk);
    const magwell = J0.along(0.19, 0.08),
      vest = [J0.hip[0] + 0.15, J0.hip[1] - 0.16];
    let target;
    if (reload < 0.2) target = mix2(J0.fore, magwell, ease(reload / 0.2));
    else if (reload < 0.45) target = mix2(magwell, vest, ease((reload - 0.2) / 0.25));
    else if (reload < 0.7) target = mix2(vest, magwell, ease((reload - 0.45) / 0.25));
    else target = mix2(magwell, J0.fore, ease((reload - 0.7) / 0.3));
    Pk.leftHand = target;
    Pk.leftBend = 1;
    if (reload > 0.2 && !geo.mags.some((m) => t - m.at < 3000)) {
      const mw = [
        geo.kneel.x - J0.along(0.19, 0.08)[0] * s,
        geo.kneel.y + (J0.along(0.19, 0.08)[1] + J0.lift) * s,
      ];
      geo.mags.push({ x: mw[0], y: mw[1], at: t });
    }
  }
  const mk = operator(ctx, geo.kneel.x, geo.kneel.y, s, -1, solve(Pk), geo.figs.kneel);

  // Dropped magazines fall and settle.
  for (const m of geo.mags) {
    const age = (t - m.at) / 1000;
    if (age > 3) continue;
    const fall = Math.min(1, age * 2.4);
    const gy = geo.ridge(m.x) - 3;
    const y = lerp(m.y, gy, fall * fall);
    ctx.save();
    ctx.translate(m.x - age * 6 * (1 - fall), y);
    ctx.rotate(fall * 1.9);
    ctx.globalAlpha = Math.min(1, (3 - age) * 2);
    ctx.fillStyle = "#1c1c1b";
    ctx.fillRect(-s * 0.012, -s * 0.03, s * 0.024, s * 0.06);
    ctx.restore();
  }
  geo.mags = geo.mags.filter((m) => t - m.at < 3200);
  ctx.globalAlpha = 1;

  // Scope glint, brighter for a moment when a run finishes.
  const cheer = Math.max(0, 1 - (t - cheerAt) / 1500);
  ctx.globalAlpha = Math.min(
    1,
    (still ? 0.5 : 0.35 + 0.3 * Math.max(0, Math.sin(t * 0.0016))) + cheer * 0.6,
  );
  ctx.drawImage(spr.flash, mk.lens[0] - 7, mk.lens[1] - 7, 14, 14);
  ctx.globalAlpha = 1;

  if (firing && t % 110 < 45) {
    const [mx, my] = mk.muzzle;
    ctx.drawImage(spr.flash, mx - 26, my - 18, 52, 36);
    ctx.fillStyle = rgba(L.tracer, 0.95);
    ctx.beginPath();
    ctx.moveTo(mx, my);
    ctx.lineTo(mx - 20, my - 5);
    ctx.lineTo(mx - 9, my);
    ctx.lineTo(mx - 20, my + 5);
    ctx.closePath();
    ctx.fill();
    if (!tracers.some((tr) => tr.shot === shot)) {
      tracers.push({ x: mx, y: my, dx: mk.dir[0], dy: mk.dir[1], at: t, shot });
      brass.push({ x: mk.eject[0], y: mk.eject[1], at: t });
      geo.puffs.push({ x: mx, y: my, at: t });
    }
  }
  for (const pf of geo.puffs) {
    const age = (t - pf.at) / 1600;
    if (age > 1) continue;
    const r = 6 + age * 26;
    ctx.globalAlpha = (1 - age) * 0.35;
    ctx.drawImage(spr.smoke, pf.x - r + age * 12, pf.y - r - age * 20, r * 2, r * 2);
  }
  ctx.globalAlpha = 1;
  for (const tr of tracers) {
    const age = (t - tr.at) / 500;
    if (age > 1) continue;
    const d = age * W * 0.9;
    const x1 = tr.x + tr.dx * d,
      y1 = tr.y + tr.dy * d - age * 6;
    ctx.strokeStyle = rgba(L.tracer, 0.9 * (1 - age));
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - tr.dx * 70, y1 - tr.dy * 70);
    ctx.stroke();
  }
  for (const b of brass) {
    const age = (t - b.at) / 700;
    if (age > 1) continue;
    const bx = b.x + age * 26,
      by = b.y - 18 * age + 70 * age * age;
    ctx.fillStyle = "rgba(220,180,90,0.9)";
    ctx.save();
    ctx.translate(bx, by);
    ctx.rotate(age * 14);
    ctx.fillRect(-2, -0.8, 4, 1.6);
    ctx.restore();
  }
  tracers = tracers.filter((tr) => t - tr.at < 600);
  brass = brass.filter((b) => t - b.at < 800);
  geo.puffs = geo.puffs.filter((pf) => t - pf.at < 1700);

  // Lens flare, vignette and grain.
  ctx.globalCompositeOperation = "lighter";
  for (const f of geo.flare) {
    ctx.globalAlpha = SCHEME === "light" ? 0.06 : 0.1;
    ctx.drawImage(spr.flash, f.x - f.r, f.y - f.r, f.r * 2, f.r * 2);
  }
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.drawImage(geo.vignette, 0, 0, W, H);
  ctx.fillStyle = geo.grain[Math.floor(t / 70) % 3];
  ctx.fillRect(0, 0, W, H);
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
