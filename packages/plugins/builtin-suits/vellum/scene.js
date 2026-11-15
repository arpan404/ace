// Vellum: laid paper under the frame. Nothing moves. The sheet (its tone, a soft fall of light
// from the top left, fine grain and a few faint fibres) is painted once whenever the size or
// the scheme changes; ticks draw nothing.

const sheets = {
  light: { paper: "#F9F4EB", light: "rgba(255, 252, 244, 0.55)", shade: "rgba(120, 92, 56, 0.07)", grain: 7, fibre: "rgba(110, 84, 52, 0.05)" },
  dark: { paper: "#1A1714", light: "rgba(255, 214, 160, 0.035)", shade: "rgba(0, 0, 0, 0.22)", grain: 5, fibre: "rgba(236, 214, 180, 0.025)" },
};
const tileSize = 192;
const fibres = 220;

let view = null;
let scheme = "light";
let dirty = true;

// A fixed seed: the same sheet on every load, so a repaint never shifts the grain.
let seed = 1;
function random() {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
}

function surface(width, height) {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

// A tile of grain: each pixel nudged lighter or darker by up to `amount` levels.
function grainTile(amount) {
  const tile = surface(tileSize, tileSize);
  const g = tile.getContext("2d");
  const image = g.createImageData(tileSize, tileSize);
  const data = image && image.data;
  // A context that can't hand out pixels gets a sheet without grain.
  if (!data) return null;
  seed = 11;
  for (let i = 0; i < data.length; i += 4) {
    const shift = (random() + random() - 1) * amount;
    const value = shift > 0 ? 255 : 0;
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = Math.round(Math.abs(shift) * 2.2);
  }
  g.putImageData(image, 0, 0);
  return tile;
}

function paint() {
  dirty = false;
  const sheet = sheets[scheme];
  const ratio = Math.min(2, view.pixelRatio);
  const width = view.width;
  const height = view.height;
  const ctx = view.canvas.getContext("2d", { alpha: false });
  view.canvas.width = Math.max(1, Math.round(width * ratio));
  view.canvas.height = Math.max(1, Math.round(height * ratio));
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

  ctx.fillStyle = sheet.paper;
  ctx.fillRect(0, 0, width, height);

  // Light falls from the top left and fades before the far corner.
  const reach = Math.hypot(width, height);
  const fall = ctx.createRadialGradient(width * 0.1, -height * 0.1, 0, width * 0.1, -height * 0.1, reach);
  fall.addColorStop(0, sheet.light);
  fall.addColorStop(0.55, "rgba(0, 0, 0, 0)");
  fall.addColorStop(1, sheet.shade);
  ctx.fillStyle = fall;
  ctx.fillRect(0, 0, width, height);

  // Fibres: short, faint, mostly along the sheet's grain direction.
  seed = 5;
  ctx.strokeStyle = sheet.fibre;
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  for (let i = 0; i < fibres; i++) {
    const x = random() * width;
    const y = random() * height;
    const length = 6 + random() * 18;
    const angle = (random() - 0.5) * 0.9;
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(
      x + Math.cos(angle) * length * 0.5,
      y + Math.sin(angle) * length * 0.5 + (random() - 0.5) * 3,
      x + Math.cos(angle) * length,
      y + Math.sin(angle) * length,
    );
  }
  ctx.stroke();

  const tile = grainTile(sheet.grain);
  if (tile) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = ctx.createPattern(tile, "repeat");
    ctx.fillRect(0, 0, view.canvas.width, view.canvas.height);
  }
}

// Painted as soon as anything changes, so a resize while ace has paused the clock never
// leaves a blank sheet; a tick only repaints if a change came before the first paint could.
ace.scene({
  init(next) {
    view = next;
    scheme = next.scheme === "dark" ? "dark" : "light";
    paint();
  },
  frame() {
    if (dirty && view) paint();
  },
  resize(next) {
    view = next;
    paint();
  },
  scheme(next) {
    scheme = next === "dark" ? "dark" : "light";
    if (view) paint();
    else dirty = true;
  },
  motion() {
    // A still sheet already: nothing to stop.
  },
  signal() {
    // Paper doesn't react; ace's own markers show what each agent is doing.
  },
});
