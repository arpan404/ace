// Starship Bridge: the view out of the bridge's forward viewport. Three layers of stars drift
// slowly past at different depths, and the limb of a planet curves up from the lower right with
// a thin lit atmosphere. By day (light) the sky is the pale haze of a planet's upper air and the
// stars are gone. Signals are moods, not state: working spools the drift up a little, done lifts
// the stars for a moment. The jump to warp is the celebration (celebration.js), not here.
// Layers are painted once into their own canvases in init and resize; frame only blits them.

const layerCount = 3;
const layerSpeed = [3, 7, 14]; // CSS px per second, far to near
const layerDensity = [0.00022, 0.00009, 0.000035]; // stars per CSS px²

let view = null;
let ctx = null;
let sky = null;
let planet = null;
const layers = [];
let width = 0;
let height = 0;
let ratio = 1;
let scheme = "dark";
let still = false;

let now = 0;
let last = -1;
let travel = 0; // px travelled by the nearest layer
let boost = 0; // 0..1, eased toward its target
let boostTarget = 0;
let liftAt = -Infinity;

// A fixed seed keeps the sky the same on every load, so the still frame never jumps.
let seed = 7;
function random() {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
}

function canvas(w, h) {
  const made = document.createElement("canvas");
  made.width = Math.max(1, Math.round(w * ratio));
  made.height = Math.max(1, Math.round(h * ratio));
  return made;
}

function paintSky() {
  sky = canvas(width, height);
  const g = sky.getContext("2d");
  g.setTransform(ratio, 0, 0, ratio, 0, 0);
  const fill = g.createLinearGradient(0, 0, width * 0.3, height);
  if (scheme === "dark") {
    fill.addColorStop(0, "#050914");
    fill.addColorStop(0.6, "#08101f");
    fill.addColorStop(1, "#0b1630");
  } else {
    fill.addColorStop(0, "#e9eef4");
    fill.addColorStop(0.6, "#e2e9f0");
    fill.addColorStop(1, "#d8e3ec");
  }
  g.fillStyle = fill;
  g.fillRect(0, 0, width, height);
  // A faint band of the galaxy's plane across the upper left (dark), high haze by day.
  const band = g.createLinearGradient(0, height * 0.05, width * 0.6, height * 0.55);
  const tint = scheme === "dark" ? "70, 110, 170" : "255, 255, 255";
  band.addColorStop(0, `rgba(${tint}, 0)`);
  band.addColorStop(0.5, `rgba(${tint}, ${scheme === "dark" ? 0.07 : 0.35})`);
  band.addColorStop(1, `rgba(${tint}, 0)`);
  g.fillStyle = band;
  g.fillRect(0, 0, width, height);
}

function paintLayers() {
  layers.length = 0;
  if (scheme !== "dark") return;
  seed = 7;
  for (let depth = 0; depth < layerCount; depth++) {
    const layer = canvas(width, height);
    const g = layer.getContext("2d");
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    const count = Math.round(width * height * layerDensity[depth]);
    for (let i = 0; i < count; i++) {
      const x = random() * width;
      const y = random() * height;
      const size = 0.6 + depth * 0.45 + random() * 0.5;
      const alpha = 0.25 + depth * 0.18 + random() * 0.25;
      // Most stars are white-blue; a few run warm or cyan.
      const pick = random();
      const hue = pick < 0.12 ? "255, 214, 170" : pick < 0.3 ? "150, 235, 245" : "214, 228, 255";
      g.fillStyle = `rgba(${hue}, ${alpha.toFixed(2)})`;
      g.fillRect(x, y, size, size);
      if (depth === 2 && random() < 0.18) {
        // A near star with a soft halo.
        const halo = g.createRadialGradient(x, y, 0, x, y, size * 4);
        halo.addColorStop(0, `rgba(${hue}, 0.22)`);
        halo.addColorStop(1, `rgba(${hue}, 0)`);
        g.fillStyle = halo;
        g.fillRect(x - size * 4, y - size * 4, size * 8, size * 8);
      }
    }
    layers.push(layer);
  }
}

function paintPlanet() {
  // The limb: a huge disc whose centre sits below the window's lower right.
  const radius = Math.max(width, height) * 0.9;
  const cx = width * 0.86;
  const cy = height + radius * 0.72;
  planet = canvas(width, height);
  const g = planet.getContext("2d");
  g.setTransform(ratio, 0, 0, ratio, 0, 0);
  const dark = scheme === "dark";

  // Atmosphere glow beyond the edge.
  const glow = g.createRadialGradient(cx, cy, radius * 0.98, cx, cy, radius * 1.08);
  glow.addColorStop(0, dark ? "rgba(63, 214, 226, 0.20)" : "rgba(0, 127, 140, 0.16)");
  glow.addColorStop(1, dark ? "rgba(63, 214, 226, 0)" : "rgba(0, 127, 140, 0)");
  g.fillStyle = glow;
  g.fillRect(0, 0, width, height);

  // The body, lit from the upper left, darkening toward its centre.
  g.beginPath();
  g.arc(cx, cy, radius, 0, Math.PI * 2);
  const body = g.createRadialGradient(
    cx - radius * 0.35,
    cy - radius * 0.95,
    radius * 0.1,
    cx,
    cy,
    radius,
  );
  if (dark) {
    body.addColorStop(0, "#12284a");
    body.addColorStop(0.55, "#0a1730");
    body.addColorStop(1, "#060d1d");
  } else {
    body.addColorStop(0, "#cfdbe6");
    body.addColorStop(0.55, "#c4d2df");
    body.addColorStop(1, "#b8c8d7");
  }
  g.fillStyle = body;
  g.fill();

  // Faint cloud bands, clipped to the disc.
  g.save();
  g.clip();
  g.strokeStyle = dark ? "rgba(120, 170, 220, 0.06)" : "rgba(255, 255, 255, 0.35)";
  g.lineWidth = 10;
  for (let i = 1; i < 7; i++) {
    g.beginPath();
    g.arc(cx, cy, radius - i * 26, Math.PI * 1.05, Math.PI * 1.75);
    g.stroke();
  }
  g.restore();

  // The lit rim: a thin line of atmosphere.
  g.beginPath();
  g.arc(cx, cy, radius, Math.PI * 1.02, Math.PI * 1.9);
  g.strokeStyle = dark ? "rgba(126, 227, 236, 0.55)" : "rgba(0, 107, 118, 0.35)";
  g.lineWidth = 1.5;
  g.stroke();
  g.beginPath();
  g.arc(cx, cy, radius + 3, Math.PI * 1.08, Math.PI * 1.7);
  g.strokeStyle = dark ? "rgba(63, 214, 226, 0.16)" : "rgba(0, 127, 140, 0.12)";
  g.lineWidth = 5;
  g.stroke();
}

function size(next) {
  view = next;
  width = Math.max(1, next.width);
  height = Math.max(1, next.height);
  ratio = Math.min(2, next.pixelRatio || 1);
  scheme = next.scheme === "light" ? "light" : "dark";
  still = Boolean(next.reduceMotion);
  ctx = next.canvas.getContext("2d", { alpha: false });
  paintSky();
  paintLayers();
  paintPlanet();
}

function blit(image, offset) {
  // A layer wraps horizontally: draw it at the offset and once more to its right.
  const x = -(offset % width);
  ctx.drawImage(image, x, 0, width, height);
  ctx.drawImage(image, x + width, 0, width, height);
}

function draw() {
  if (!ctx) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.globalAlpha = 1;
  ctx.drawImage(sky, 0, 0, width, height);
  const lift = still ? 0 : Math.max(0, 1 - (now - liftAt) / 1600);
  for (let depth = 0; depth < layers.length; depth++) {
    ctx.globalAlpha = Math.min(1, 0.85 + lift * 0.15);
    blit(layers[depth], (travel * layerSpeed[depth]) / layerSpeed[layerCount - 1]);
  }
  ctx.globalAlpha = 1;
  ctx.drawImage(planet, 0, 0, width, height);
}

ace.scene({
  init(next) {
    size(next);
    draw();
  },
  frame(time, next) {
    now = time;
    if (next.width !== width || next.height !== height || next.scheme !== scheme) size(next);
    if (still || next.reduceMotion) {
      last = time;
      draw();
      return;
    }
    const dt = last < 0 ? 0 : Math.min(100, time - last) / 1000;
    last = time;
    boost += (boostTarget - boost) * Math.min(1, dt * 1.5);
    travel += dt * layerSpeed[layerCount - 1] * (1 + boost * 2);
    draw();
  },
  signal(name) {
    if (name === "working") boostTarget = 1;
    else boostTarget = 0;
    if (name === "done" || name === "pr-merged") liftAt = now;
  },
  resize(next) {
    size(next);
    draw();
  },
  scheme(next) {
    if (view) {
      scheme = next === "light" ? "light" : "dark";
      size(view);
      draw();
    }
  },
  motion(reduceMotion) {
    still = reduceMotion;
    draw();
  },
});
