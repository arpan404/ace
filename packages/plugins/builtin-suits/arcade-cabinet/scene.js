// Arcade Cabinet: a calm pixel night sky behind ace. It is drawn at one third of the window's
// size into a small canvas and scaled up without smoothing, so every star is a crisp pixel.
// Three layers of stars drift left at different speeds, a ringed planet and two bands of pixel
// cloud sit far behind. Signals are short: working speeds the drift up, waiting blinks a "!",
// failed shakes the sky and flashes it red and done twinkles. STAGE CLEAR! plays above the UI
// as the Suit's celebration (stage-clear.js), not here.
// Everything is allocated in init and resize; frame only moves numbers and draws.

const art = 3; // CSS px per art pixel
const maxStars = 260;

const sky = ["#0b0920", "#0e0b28", "#120e32", "#16123c"];
const starColours = ["#4a43a0", "#9a93e0", "#f2efff"];

// Own 5x7 glyph for the waiting bubble, 35 bits.
const glyphs = {
  "!": "..#....#....#....#....#.........#..",
};

let ctx = null;
let buffer = null;
let pix = null;
let width = 0;
let height = 0;
let ratio = 1;
let cols = 1;
let rows = 1;
let still = false;
let now = 0;
let last = -1;
let count = 0;

let speedUntil = -Infinity;
let waitingAt = -Infinity;
let failedAt = -Infinity;
let doneAt = -Infinity;

const starX = new Float32Array(maxStars);
const starY = new Float32Array(maxStars);
const starLayer = new Uint8Array(maxStars);
const starPhase = new Float32Array(maxStars);

let cloudOffset = 0;
let drift = 0;

// A fixed seed keeps the sky the same on every load, so a still frame never jumps.
let seed = 11;
function random() {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
}

function size(view) {
  if (typeof view.reduceMotion === "boolean") still = view.reduceMotion;
  width = view.width;
  height = view.height;
  ratio = Math.min(2, view.pixelRatio);
  view.canvas.width = Math.max(1, Math.round(width * ratio));
  view.canvas.height = Math.max(1, Math.round(height * ratio));
  ctx = view.canvas.getContext("2d", { alpha: false });
  cols = Math.max(1, Math.ceil(width / art));
  rows = Math.max(1, Math.ceil(height / art));
  if (!buffer) buffer = document.createElement("canvas");
  buffer.width = cols;
  buffer.height = rows;
  pix = buffer.getContext("2d", { alpha: false });
  count = Math.max(60, Math.min(maxStars, Math.round((cols * rows) / 260)));
  seed = 11;
  for (let i = 0; i < maxStars; i++) {
    starX[i] = random() * cols;
    starY[i] = random() * rows;
    const r = random();
    starLayer[i] = r < 0.6 ? 0 : r < 0.9 ? 1 : 2;
    starPhase[i] = random() * Math.PI * 2;
  }
}

function fill(colour, x, y, w, h) {
  pix.fillStyle = colour;
  pix.fillRect(x | 0, y | 0, w, h);
}

function drawSky() {
  const band = Math.ceil(rows / sky.length);
  for (let i = 0; i < sky.length; i++) fill(sky[i], 0, i * band, cols, band + 1);
  // Dithered seams between the bands: a checker row on each edge, as old hardware would.
  for (let i = 1; i < sky.length; i++) {
    pix.fillStyle = sky[i - 1];
    const y = i * band;
    for (let x = i & 1; x < cols; x += 2) pix.fillRect(x, y, 1, 1);
    pix.fillStyle = sky[i];
    for (let x = (i + 1) & 1; x < cols; x += 2) pix.fillRect(x, y - 1, 1, 1);
  }
}

function drawPlanet(shiftX, shiftY) {
  const cx = Math.round(cols * 0.82) + shiftX;
  const cy = Math.round(rows * 0.74) + shiftY;
  const r = Math.max(8, Math.round(Math.min(cols, rows) * 0.07));
  // Body, stepped into rows so its outline stays pixel-round.
  for (let dy = -r; dy <= r; dy++) {
    const half = Math.round(Math.sqrt(r * r - dy * dy));
    const shade = dy < -r * 0.3 ? "#2c2668" : dy < r * 0.4 ? "#231e57" : "#1b1746";
    fill(shade, cx - half, cy + dy, half * 2, 1);
  }
  // Light from the upper left: a small crescent of brighter pixels.
  for (let dy = -r + 1; dy < -r * 0.2; dy++) {
    const half = Math.round(Math.sqrt(r * r - dy * dy));
    fill("#3a3486", cx - half, cy + dy, Math.max(1, Math.round(half * 0.5)), 1);
  }
  // The ring: a flat stepped ellipse in front.
  const ringW = r * 2 + 8;
  fill("#4a43a0", cx - (ringW >> 1), cy + 1, ringW, 1);
  fill("#352f7c", cx - (ringW >> 1) + 2, cy + 2, ringW - 4, 1);
}

function drawClouds(offset) {
  // Two long bands of pixel cloud far behind, scrolling very slowly.
  const span = cols + 80;
  for (let layer = 0; layer < 2; layer++) {
    const y = Math.round(rows * (layer === 0 ? 0.3 : 0.55));
    const colour = layer === 0 ? "#151140" : "#181448";
    const o = (offset * (layer === 0 ? 0.5 : 1)) % span;
    for (let k = 0; k < 5; k++) {
      const x = (((k * span) / 5 - o + span) % span) - 40;
      fill(colour, x, y, 34, 2);
      fill(colour, x + 6, y - 2, 20, 2);
      fill(colour, x + 12, y - 3, 8, 1);
      fill(colour, x - 6, y + 2, 46, 1);
    }
  }
}

function drawStars(time, speed, dt, shiftX, shiftY) {
  for (let i = 0; i < count; i++) {
    const layer = starLayer[i];
    const v = layer === 0 ? 0.6 : layer === 1 ? 1.6 : 3.2;
    let x = starX[i] - (dt / 1000) * v * speed;
    if (x < 0) {
      x += cols;
      starY[i] = random() * rows;
    }
    starX[i] = x;
    const twinkle = still ? 1 : Math.sin(time * 0.002 + starPhase[i]);
    if (layer === 2 && twinkle > 0.6) {
      // A bright star flares into a small cross.
      fill(starColours[2], x + shiftX, starY[i] + shiftY, 1, 1);
      fill(starColours[1], x - 1 + shiftX, starY[i] + shiftY, 1, 1);
      fill(starColours[1], x + 1 + shiftX, starY[i] + shiftY, 1, 1);
      fill(starColours[1], x + shiftX, starY[i] - 1 + shiftY, 1, 1);
      fill(starColours[1], x + shiftX, starY[i] + 1 + shiftY, 1, 1);
    } else {
      fill(starColours[layer], x + shiftX, starY[i] + shiftY, 1, 1);
    }
  }
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

function drawWaiting(since) {
  // A "!" bubble in the upper right that blinks for four seconds.
  if (since > 4000) return;
  if (!still && (Math.floor(since / 250) & 1) === 1) return;
  const x = cols - 22;
  const y = 22; // below the header bar, which is solid
  fill("#07061a", x - 1, y, 13, 15);
  fill("#f2efff", x, y + 1, 11, 13);
  fill("#f2efff", x + 2, y + 14, 3, 2);
  drawText("!", x + 3, y + 3, 1, "#07061a");
  fill("#07061a", x + 5, y + 3, 1, 5);
}

function draw(time) {
  const dt = last < 0 ? 0 : Math.min(100, time - last);
  last = time;
  const working = !still && time < speedUntil;
  const speed = still ? 0 : working ? 3 : 1;

  const sinceFail = time - failedAt;
  const shaking = !still && sinceFail >= 0 && sinceFail < 400;
  const shiftX = shaking ? (Math.floor(sinceFail / 50) & 1 ? 1 : -1) : 0;
  const shiftY = shaking ? (Math.floor(sinceFail / 70) & 1 ? 1 : 0) : 0;

  drawSky();
  drift += (dt / 1000) * speed;
  cloudOffset = drift * 1.5;
  drawClouds(cloudOffset);
  drawPlanet(shiftX, shiftY);
  drawStars(time, speed, dt, shiftX, shiftY);

  const sinceDone = time - doneAt;
  if (!still && sinceDone >= 0 && sinceDone < 1200) {
    const a = 1 - sinceDone / 1200;
    pix.globalAlpha = a;
    for (let i = 0; i < count; i += 9) fill("#b8fff8", starX[i], starY[i], 1, 1);
    pix.globalAlpha = 1;
  }

  if (sinceFail >= 0 && sinceFail < 600 && !still) {
    pix.globalAlpha = 0.18 * (1 - sinceFail / 600);
    fill("#ff3b5c", 0, 0, cols, rows);
    pix.globalAlpha = 1;
  }

  const sinceWait = time - waitingAt;
  if (sinceWait >= 0) drawWaiting(sinceWait);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
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
  motion(reduceMotion) {
    still = reduceMotion;
  },
  frame(time) {
    now = time;
    draw(time);
  },
  signal(name) {
    if (name === "working") speedUntil = now + 2500;
    else if (name === "waiting") waitingAt = now;
    else if (name === "failed") failedAt = now;
    else if (name === "done") doneAt = now;
  },
});
