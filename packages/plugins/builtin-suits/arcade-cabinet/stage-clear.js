// Arcade Cabinet's celebration: ace shows this frame above the UI for a moment when the open
// thread's run finishes (LEVEL UP!) or a pull request merges (STAGE CLEAR!). The frame is
// transparent where nothing is drawn, so the app shows through; ace cuts holes around the
// approval strip, the Working line and status icons, and takes the frame down after 4 s.
// Like the backdrop, it draws at one third of the window's size and scales up without
// smoothing. It never runs under Reduce motion. Everything is allocated in init and resize.

const art = 3; // CSS px per art pixel
const maxConfetti = 120;
const playMs = 3000;

const confettiColours = ["#38e0d4", "#f2efff", "#9a93e0", "#ffd866", "#ff9ad5", "#7df0c8"];

// Own 5x7 capitals, one string of 35 bits per letter.
const glyphs = {
  S: ".#####....#.....###.....#....#####.",
  T: "#####..#....#....#....#....#....#..",
  A: ".###.#...##...#######...##...##...#",
  G: ".###.#...##....#.####...##...#.####",
  E: "######....#....####.#....#....#####",
  C: ".###.#...##....#....#....#...#.###.",
  L: "#....#....#....#....#....#....#####",
  R: "####.#...##...#####.#.#..#..#.#...#",
  V: "#...##...##...##...##...#.#.#...#..",
  U: "#...##...##...##...##...##...#.###.",
  P: "####.#...##...#####.#....#....#....",
  "!": "..#....#....#....#....#.........#..",
  " ": "",
};

let ctx = null;
let buffer = null;
let pix = null;
let ratio = 1;
let cols = 1;
let rows = 1;
let now = 0;
let last = -1;
let startedAt = -1;
let banner = "STAGE CLEAR!";
let over = false;

const confX = new Float32Array(maxConfetti);
const confY = new Float32Array(maxConfetti);
const confVX = new Float32Array(maxConfetti);
const confVY = new Float32Array(maxConfetti);
const confColour = new Uint8Array(maxConfetti);

let seed = 7;
function random() {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
}

function size(view) {
  ratio = Math.min(2, view.pixelRatio);
  view.canvas.width = Math.max(1, Math.round(view.width * ratio));
  view.canvas.height = Math.max(1, Math.round(view.height * ratio));
  ctx = view.canvas.getContext("2d");
  cols = Math.max(1, Math.ceil(view.width / art));
  rows = Math.max(1, Math.ceil(view.height / art));
  if (!buffer) buffer = document.createElement("canvas");
  buffer.width = cols;
  buffer.height = rows;
  pix = buffer.getContext("2d");
}

function fill(colour, x, y, w, h) {
  pix.fillStyle = colour;
  pix.fillRect(x | 0, y | 0, w, h);
}

function drawText(text, x, y, scale, colour) {
  pix.fillStyle = colour;
  let cx = x;
  for (const letter of text) {
    const bits = glyphs[letter] ?? "";
    for (let i = 0; i < bits.length; i++) {
      if (bits[i] !== "#") continue;
      pix.fillRect(cx + (i % 5) * scale, y + Math.floor(i / 5) * scale, scale, scale);
    }
    cx += 6 * scale;
  }
}

// The main column sits right of the sidebar, so the burst centres there, not on the window.
const centreX = () => Math.round(cols * (cols > 300 ? 0.62 : 0.5));
const centreY = () => Math.round(rows * 0.4);

function startConfetti() {
  const cx = centreX();
  const cy = centreY();
  for (let i = 0; i < maxConfetti; i++) {
    const angle = random() * Math.PI * 2;
    const speed = 40 + random() * 110;
    confX[i] = cx;
    confY[i] = cy;
    confVX[i] = Math.cos(angle) * speed;
    confVY[i] = Math.sin(angle) * speed - 70;
    confColour[i] = Math.floor(random() * confettiColours.length);
  }
}

function draw(since, dt) {
  pix.clearRect(0, 0, cols, rows);
  const cx = centreX();
  const cy = centreY();
  const fade = since > playMs - 600 ? Math.max(0, (playMs - since) / 600) : 1;
  // Rays: eight stepped spokes that grow, then fade with the banner.
  const reach = Math.min(1, since / 400) * Math.min(cols, rows) * 0.5;
  pix.globalAlpha = 0.55 * fade;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + since * 0.0004;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    for (let s = 10; s < reach; s += 3) fill("#38e0d4", cx + dx * s, cy + dy * s, 2, 2);
  }
  // Confetti under gravity, as square pixels.
  pix.globalAlpha = fade;
  const step = dt / 1000;
  for (let i = 0; i < maxConfetti; i++) {
    confVY[i] += 130 * step;
    confX[i] += confVX[i] * step;
    confY[i] += confVY[i] * step;
    fill(confettiColours[confColour[i]], confX[i], confY[i], 2, 2);
  }
  // The banner in a notched plate, popping in after a beat.
  if (since > 120) {
    const scale = cols > 200 ? 3 : 2;
    const textW = banner.length * 6 * scale - scale;
    const textH = 7 * scale;
    const plateW = textW + 12 * scale;
    const plateH = textH + 8 * scale;
    const px = Math.round(cx - plateW / 2);
    const py = Math.round(cy - plateH / 2);
    fill("#07061a", px - 1, py, plateW + 2, plateH);
    fill("#07061a", px, py - 1, plateW, plateH + 2);
    fill("#38e0d4", px + 1, py, plateW - 2, plateH);
    fill("#38e0d4", px, py + 1, plateW, plateH - 2);
    fill("#1b1842", px + 2, py + 2, plateW - 4, plateH - 4);
    const tx = Math.round(cx - textW / 2);
    const ty = Math.round(cy - textH / 2);
    drawText(banner, tx + scale, ty + scale, scale, "#07061a");
    drawText(banner, tx, ty, scale, (Math.floor(since / 160) & 1) === 0 ? "#f2efff" : "#b8fff8");
  }
  pix.globalAlpha = 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cols * art * ratio, rows * art * ratio);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(buffer, 0, 0, cols * art * ratio, rows * art * ratio);
}

ace.scene({
  init(view) {
    size(view);
  },
  resize(view) {
    size(view);
  },
  signal(name) {
    if (name !== "done" && name !== "pr-merged") return;
    banner = name === "done" ? "LEVEL UP!" : "STAGE CLEAR!";
    startedAt = now;
    last = -1;
    over = false;
    startConfetti();
  },
  frame(time) {
    now = time;
    if (startedAt < 0 || over) return;
    const dt = last < 0 ? 0 : Math.min(100, time - last);
    last = time;
    const since = time - startedAt;
    if (since >= playMs) {
      over = true;
      ctx.clearRect(0, 0, cols * art * ratio, rows * art * ratio);
      ace.finish();
      return;
    }
    draw(since, dt);
  },
});
