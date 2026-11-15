// Tidewater's celebration: when the work lands, a wave washes across the window and recedes.
//
// A swell rises from the bottom edge, its face a translucent sea-blue under a foaming crest
// with bubbles, runs up to about two thirds of the window, then draws back down the way it came.
// Where it reached, the "sand" stays wet for a moment: a faint sheen and a scatter of sparkles
// that twinkle and fade. A merged pull request sends a bigger wave and leaves more sparkles.
// About 3.2 s in all, then the canvas is clear and ace takes the layer down. Shapes and
// gradients only; the sparkle sprite is built once.

const riseMs = 1200;
const turnMs = 1450;
const ebbMs = 2350;
const endMs = 3200;

let ctx = null;
let doc = null;
let width = 1;
let height = 1;
let ratio = 1;
let scheme = "light";
let startAt = -1;
let pending = false;
let merged = false;
let finished = false;

let sparkle = null;
const sparkles = [];
const bubbles = [];

let seed = 9;
function random() {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
}

function build(view) {
  width = view.width;
  height = view.height;
  ratio = view.pixelRatio || 1;
  scheme = view.scheme === "dark" ? "dark" : "light";
  ctx = view.canvas.getContext("2d");
  if (!sparkle) {
    sparkle = doc.createElement("canvas");
    sparkle.width = 64;
    sparkle.height = 64;
    const g = sparkle.getContext("2d");
    const halo = g.createRadialGradient(32, 32, 0, 32, 32, 30);
    halo.addColorStop(0, "rgba(255,250,235,1)");
    halo.addColorStop(0.2, "rgba(255,240,205,0.5)");
    halo.addColorStop(1, "rgba(255,240,205,0)");
    g.fillStyle = halo;
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = "rgba(255,252,240,1)";
    g.beginPath();
    g.moveTo(32, 3);
    g.lineTo(34.5, 29.5);
    g.lineTo(61, 32);
    g.lineTo(34.5, 34.5);
    g.lineTo(32, 61);
    g.lineTo(29.5, 34.5);
    g.lineTo(3, 32);
    g.lineTo(29.5, 29.5);
    g.closePath();
    g.fill();
  }
  seed = 9;
  sparkles.length = 0;
  for (let i = 0; i < 40; i++)
    sparkles.push({
      x: random(),
      y: random(),
      s: 11 + random() * 15,
      p: random() * 6.28,
      big: random() < 0.6,
    });
  bubbles.length = 0;
  for (let i = 0; i < 70; i++)
    bubbles.push({ x: random(), o: random() * 18, r: 1 + random() * 3.2 });
}

const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (p) => 1 - Math.pow(1 - p, 3);
const easeInOut = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);

// How far up the window the water reaches (0..1) at time t.
function reach(t) {
  const top = merged ? 0.8 : 0.66;
  if (t < riseMs) return top * easeOut(t / riseMs);
  if (t < turnMs) return top;
  return top * (1 - easeInOut(clamp((t - turnMs) / (ebbMs - turnMs))));
}

// The wave's edge, px from the top, along x.
function edge(x, level, t) {
  const k = (Math.PI * 2) / (width * 0.42);
  return (
    height * (1 - level) +
    Math.sin(x * k + t * 0.004) * 10 +
    Math.sin(x * k * 2.6 - t * 0.006 + 1.3) * 5
  );
}

function draw(t) {
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (t >= endMs) {
    finished = true;
    // Hosts older than the celebration contract have no finish(); they take the layer down on time.
    if (typeof ace.finish === "function") ace.finish();
    return;
  }
  const dark = scheme === "dark";
  const level = reach(t);
  const highest = merged ? 0.8 : 0.66;
  const fade = t > ebbMs ? 1 - clamp((t - ebbMs) / (endMs - ebbMs)) : 1;

  // The wet sand the wave leaves behind: a sheen between its high mark and where it is now.
  if (t > turnMs) {
    const wet = 1 - clamp((t - turnMs) / (endMs - turnMs));
    const yTop = height * (1 - highest);
    const sheen = ctx.createLinearGradient(0, yTop, 0, height);
    sheen.addColorStop(0, `rgba(${dark ? "140,190,210" : "120,170,185"},0)`);
    sheen.addColorStop(0.25, `rgba(${dark ? "140,190,210" : "120,170,185"},${0.18 * wet})`);
    sheen.addColorStop(1, `rgba(${dark ? "140,190,210" : "120,170,185"},${0.06 * wet})`);
    ctx.fillStyle = sheen;
    ctx.fillRect(0, yTop, width, height - yTop);
  }

  if (level > 0.002) {
    const step = Math.max(10, width / 90);
    // The water's body.
    ctx.beginPath();
    ctx.moveTo(0, height);
    for (let x = 0; x <= width + step; x += step) ctx.lineTo(x, edge(x, level, t));
    ctx.lineTo(width, height);
    ctx.closePath();
    const yEdge = height * (1 - level);
    const body = ctx.createLinearGradient(0, yEdge, 0, height);
    body.addColorStop(0, dark ? "rgba(70,140,165,0.38)" : "rgba(110,175,192,0.42)");
    body.addColorStop(0.4, dark ? "rgba(30,90,115,0.32)" : "rgba(70,140,165,0.32)");
    body.addColorStop(1, dark ? "rgba(14,50,70,0.3)" : "rgba(40,105,130,0.26)");
    ctx.fillStyle = body;
    ctx.fill();

    // The foaming crest: a broad soft band and a bright line.
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (let x = 0; x <= width + step; x += step) {
      const y = edge(x, level, t);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = dark ? "rgba(200,230,240,0.28)" : "rgba(255,255,255,0.7)";
    ctx.lineWidth = 9;
    ctx.stroke();
    ctx.strokeStyle = dark ? "rgba(225,242,248,0.65)" : "rgba(255,255,255,0.95)";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Lace of foam a little behind the crest.
    ctx.beginPath();
    for (let x = 0; x <= width + step; x += step) {
      const y = edge(x, level, t) + 14 + Math.sin(x * 0.05 + t * 0.003) * 3;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.setLineDash([3, 7]);
    ctx.strokeStyle = dark ? "rgba(210,236,244,0.35)" : "rgba(255,255,255,0.75)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([]);

    // Bubbles riding just under the crest.
    ctx.fillStyle = dark ? "rgba(225,242,248,0.5)" : "rgba(255,255,255,0.85)";
    for (const b of bubbles) {
      const x = b.x * width;
      const y = edge(x, level, t) + 6 + b.o;
      ctx.beginPath();
      ctx.arc(x, y, b.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Sparkles on the wet sand: each lights as the water uncovers it and twinkles until the end.
  if (t > turnMs) {
    const count = merged ? sparkles.length : 28;
    const appear = clamp((t - turnMs) / 260);
    for (let i = 0; i < count; i++) {
      const s = sparkles[i];
      const x = s.x * width;
      const sy = height * (1 - highest * (0.1 + s.y * 0.86));
      if (sy > edge(x, level, t) - 6) continue;
      const twinkle = 0.55 + 0.45 * Math.sin(t * 0.012 + s.p);
      const a = appear * fade * twinkle;
      if (a < 0.02) continue;
      ctx.globalAlpha = Math.min(1, a * (dark ? 0.95 : 1));
      const size = s.s * (0.7 + twinkle * 0.45) * (s.big ? 1 : 0.6);
      ctx.drawImage(sparkle, x - size, sy - size, size * 2, size * 2);
    }
    ctx.globalAlpha = 1;
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
  signal(name) {
    if (startAt >= 0 || pending) return;
    merged = name === "pr-merged";
    // The clock is shared, so the wave starts from the next frame's time, whatever it reads.
    pending = true;
  },
  frame(time, view) {
    if (pending) {
      pending = false;
      startAt = time;
    }
    if (view.width !== width || view.height !== height || view.scheme !== scheme) build(view);
    if (startAt < 0 || finished) {
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);
      return;
    }
    draw(time - startAt);
  },
});
