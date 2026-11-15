// Phosphor: the glass of a green terminal. The tube's glow and its vignette are painted once on
// init and resize; a frame blits them and draws only a soft refresh band rolling down the screen.
//
// Signals are moods: working speeds the band, waiting brightens the glow for a moment, failed
// jitters a strip of the screen, and a merged pull request sweeps a bright line top to bottom.

let ctx = null;
let tube = null;
let width = 0;
let height = 0;
let ratio = 1;
let still = false;
// Scene time of the last frame: signals are stamped on ace's clock.
let last = 0;

let workingAt = -Infinity;
let waitingAt = -Infinity;
let failedAt = -Infinity;
let mergedAt = -Infinity;

function surface(w, h) {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(w, h);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

function paintTube() {
  tube = surface(Math.round(width * ratio), Math.round(height * ratio));
  const g = tube.getContext("2d", { alpha: false });
  g.setTransform(ratio, 0, 0, ratio, 0, 0);
  g.fillStyle = "#040906";
  g.fillRect(0, 0, width, height);
  // The phosphor's glow, brightest at the centre of the tube.
  const glow = g.createRadialGradient(
    width / 2,
    height / 2,
    0,
    width / 2,
    height / 2,
    Math.max(width, height) * 0.7,
  );
  glow.addColorStop(0, "rgba(60, 160, 90, 0.10)");
  glow.addColorStop(0.6, "rgba(30, 90, 50, 0.04)");
  glow.addColorStop(1, "rgba(0, 0, 0, 0.35)");
  g.fillStyle = glow;
  g.fillRect(0, 0, width, height);
}

function setup(view) {
  ctx = view.canvas.getContext("2d", { alpha: false });
  width = view.width;
  height = view.height;
  ratio = Math.min(2, view.pixelRatio);
  still = view.reduceMotion;
  paintTube();
}

const since = (time, at) => (time - at) / 1000;

function band(y, size, alpha) {
  const fade = ctx.createLinearGradient(0, y - size, 0, y + size);
  fade.addColorStop(0, "rgba(120, 255, 160, 0)");
  fade.addColorStop(0.5, `rgba(120, 255, 160, ${alpha})`);
  fade.addColorStop(1, "rgba(120, 255, 160, 0)");
  ctx.fillStyle = fade;
  ctx.fillRect(0, y - size, width, size * 2);
}

function draw(time) {
  if (!ctx || !tube) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(tube, 0, 0);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

  if (!still) {
    const speed = since(time, workingAt) < 4 ? 2.2 : 1;
    const period = 9000 / speed;
    const y = ((time % period) / period) * (height + 240) - 120;
    band(y, 120, 0.035);
  }

  const wait = since(time, waitingAt);
  if (wait >= 0 && wait < 1.6) {
    ctx.fillStyle = `rgba(120, 255, 160, ${0.05 * (1 - wait / 1.6)})`;
    ctx.fillRect(0, 0, width, height);
  }

  const fail = since(time, failedAt);
  if (fail >= 0 && fail < 0.5) {
    const strip = height * 0.4;
    const shift = (Math.floor(time / 40) % 2 === 0 ? 6 : -6) * (1 - fail / 0.5);
    ctx.drawImage(tube, 0, strip * ratio, width * ratio, 30 * ratio, shift, strip, width, 30);
  }

  const sweep = since(time, mergedAt);
  if (sweep >= 0 && sweep < 1.2) band((sweep / 1.2) * height, 18, 0.18 * (1 - sweep / 1.2));
}

ace.scene({
  init: setup,
  resize: setup,
  frame(time) {
    last = time;
    draw(time);
  },
  motion(reduceMotion) {
    still = reduceMotion;
  },
  signal(name) {
    if (name === "working") workingAt = last;
    else if (name === "waiting") waitingAt = last;
    else if (name === "failed") failedAt = last;
    else if (name === "pr-merged") mergedAt = last;
  },
});
