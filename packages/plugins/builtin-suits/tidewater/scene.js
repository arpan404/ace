// Tidewater's backdrop: the harbour water at the window's edges.
//
// Day: a bright coastal morning. Pale sea-washed paper, a warm wash of sun from the upper left,
// and along the bottom edge a few slow swells with light glinting on their faces. Night: the
// harbour after dark, deep blue-black water, a lighthouse beam sweeping slowly from beyond the
// upper right corner, and the same swells catching its light.
//
// Everything stays in a narrow brightness band in each scheme so text over it reads; the swells
// live in the bottom strip, the beam is faint. Sprites (sun wash, beam) are built once per size
// and scheme; a frame is a gradient fill, a handful of wave paths, a few dozen glints and, at
// night, one rotated beam blit. Signals brighten the glints for a moment.

const palette = {
  light: {
    top: "#f3f6f5",
    bottom: "#e9f0ef",
    sun: "255,240,210",
    swells: ["rgba(188,214,218,0.55)", "rgba(160,198,206,0.5)", "rgba(132,180,192,0.45)"],
    crest: "rgba(255,255,255,0.75)",
    glint: "255,255,255",
  },
  dark: {
    top: "#0d1820",
    bottom: "#0b1a22",
    sun: "120,160,190",
    swells: ["rgba(26,60,76,0.7)", "rgba(22,54,70,0.7)", "rgba(18,48,64,0.75)"],
    crest: "rgba(150,195,210,0.22)",
    glint: "214,236,244",
  },
};

let ctx = null;
let doc = null;
let width = 1;
let height = 1;
let ratio = 1;
let scheme = "light";
let now = 0;
let liftAt = -1e9;
let tick = 0;
let fresh = true;
let reduce = false;

let sun = null;
let beam = null;
const glints = [];

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

function build(view) {
  width = view.width;
  height = view.height;
  ratio = view.pixelRatio || 1;
  scheme = view.scheme === "dark" ? "dark" : "light";
  reduce = !!view.reduceMotion;
  ctx = view.canvas.getContext("2d");
  const p = palette[scheme];

  sun = canvas(256, 256);
  const s = sun.getContext("2d");
  const glow = s.createRadialGradient(128, 128, 0, 128, 128, 128);
  glow.addColorStop(0, `rgba(${p.sun},${scheme === "dark" ? 0.07 : 0.26})`);
  glow.addColorStop(1, `rgba(${p.sun},0)`);
  s.fillStyle = glow;
  s.fillRect(0, 0, 256, 256);

  // The lighthouse beam: a long narrow wedge, brightest at its source, built pointing right.
  beam = canvas(512, 128);
  const b = beam.getContext("2d");
  const along = b.createLinearGradient(0, 0, 512, 0);
  along.addColorStop(0, "rgba(255,236,190,0.16)");
  along.addColorStop(0.5, "rgba(255,236,190,0.06)");
  along.addColorStop(1, "rgba(255,236,190,0)");
  b.fillStyle = along;
  b.beginPath();
  b.moveTo(0, 60);
  b.lineTo(512, 0);
  b.lineTo(512, 128);
  b.lineTo(0, 68);
  b.closePath();
  b.fill();

  seed = 3;
  glints.length = 0;
  for (let i = 0; i < 46; i++) {
    glints.push({
      x: random(),
      band: Math.floor(random() * 3),
      len: 4 + random() * 10,
      rate: 0.0006 + random() * 0.0012,
      phase: random() * 6.28,
    });
  }
  fresh = true;
}

// The surface of swell `i` at x, in px above the window's bottom.
function swell(i, x, t) {
  const base = height * (0.05 + i * 0.035);
  const k = (Math.PI * 2) / (width * (0.55 - i * 0.1));
  const drift = t * (0.00012 + i * 0.00005);
  return (
    base +
    Math.sin(x * k + drift * 6.28 + i * 1.7) * (5 + i * 2) +
    Math.sin(x * k * 2.3 - drift * 4.1 + i) * 2.5
  );
}

function draw(t) {
  const p = palette[scheme];
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const fill = ctx.createLinearGradient(0, 0, 0, height);
  fill.addColorStop(0, p.top);
  fill.addColorStop(1, p.bottom);
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, width, height);

  // Morning sun from the upper left; at night, a faint sky glow there instead.
  const r = Math.max(width, height) * 0.9;
  ctx.drawImage(sun, -r * 0.45, -r * 0.55, r, r);

  // Night: the lighthouse beam, sweeping a slow arc from beyond the upper right corner.
  if (scheme === "dark") {
    const sweep = Math.sin(t * 0.00028) * 0.5 + 0.5;
    const angle = Math.PI * (0.62 + sweep * 0.42);
    const reach = Math.hypot(width, height) * 1.1;
    ctx.save();
    ctx.translate(width + 30, -30);
    ctx.rotate(angle);
    ctx.globalAlpha = 0.85;
    ctx.drawImage(beam, 0, -reach * 0.09, reach, reach * 0.18);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // The swells along the bottom edge, back to front.
  const step = Math.max(12, width / 80);
  for (let i = 2; i >= 0; i--) {
    ctx.beginPath();
    ctx.moveTo(0, height);
    for (let x = 0; x <= width + step; x += step) ctx.lineTo(x, height - swell(i, x, t));
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fillStyle = p.swells[i];
    ctx.fill();
    // Foam along each crest.
    ctx.beginPath();
    for (let x = 0; x <= width + step; x += step) {
      const y = height - swell(i, x, t);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = p.crest;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Light glinting on the swells' faces.
  const lift = Math.max(0, 1 - (t - liftAt) / 1800);
  ctx.lineCap = "round";
  ctx.lineWidth = 1.4;
  for (const g of glints) {
    const x = g.x * width;
    const y = height - swell(g.band, x, t) + 5 + g.band * 3;
    const shine = Math.max(0, Math.sin(t * g.rate + g.phase));
    const a = shine * shine * (scheme === "dark" ? 0.35 : 0.8) * (1 + lift * 0.8);
    if (a < 0.03) continue;
    ctx.strokeStyle = `rgba(${p.glint},${Math.min(1, a)})`;
    ctx.beginPath();
    ctx.moveTo(x - g.len / 2, y);
    ctx.lineTo(x + g.len / 2, y);
    ctx.stroke();
  }
}

ace.scene({
  init(view) {
    doc = view.canvas.ownerDocument || (typeof document === "undefined" ? null : document);
    build(view);
  },
  resize(view) {
    build(view);
  },
  scheme() {
    fresh = true;
  },
  motion(reduceMotion) {
    reduce = reduceMotion;
    fresh = true;
  },
  signal(name) {
    if (name === "done" || name === "pr-merged") liftAt = now;
  },
  frame(time, view) {
    now = time;
    if (view.width !== width || view.height !== height || (view.scheme === "dark") !== (scheme === "dark"))
      build(view);
    // The water moves slowly; every other tick is enough, and a still frame under Reduce motion.
    tick++;
    if (!fresh && (tick % 2 === 1 || reduce || view.reduceMotion)) return;
    fresh = false;
    draw(view.reduceMotion ? 0 : time);
  },
});
