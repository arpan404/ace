// Neon District: a megacity skyline at night in the rain. The sky, both rows of towers and their
// lit windows are painted once into an offscreen city on init and resize; a frame blits it, then
// draws only what moves: flickering windows, neon signs, rain and the odd scanline glitch.
//
// Signals set a mood, never a state (ace's own markers show what each agent is doing):
// working speeds the rain, waiting pulses one sign amber, failed tears the picture red for a
// moment, and a merged pull request flashes every sign and sweeps a light across the city.

const magenta = "#FF2D95";
const cyan = "#3DF2FF";
const lime = "#C8F560";
const amber = "#FFB547";
const signColours = [magenta, cyan, magenta, lime, cyan, magenta, cyan, "#B18CFF"];

const maxDrops = 220;
const maxFlicker = 48;
const maxSigns = 9;

let ctx = null;
let city = null;
let width = 0;
let height = 0;
let ratio = 1;
let still = false;
let last = -1;

// Moods: each is the time it started, or -Infinity.
let mergedAt = -Infinity;
let failedAt = -Infinity;
let waitingAt = -Infinity;
let workingAt = -Infinity;
let nextGlitch = 6000;
let glitchAt = -Infinity;

const dropX = new Float32Array(maxDrops);
const dropY = new Float32Array(maxDrops);
const dropLen = new Float32Array(maxDrops);
const dropSpeed = new Float32Array(maxDrops);
let drops = 0;

const flickX = new Float32Array(maxFlicker);
const flickY = new Float32Array(maxFlicker);
const flickW = new Float32Array(maxFlicker);
const flickPhase = new Float32Array(maxFlicker);
let flickers = 0;

const signX = new Float32Array(maxSigns);
const signY = new Float32Array(maxSigns);
const signW = new Float32Array(maxSigns);
const signH = new Float32Array(maxSigns);
const signPhase = new Float32Array(maxSigns);
const signColour = new Array(maxSigns).fill(magenta);
let signs = 0;

// A fixed seed keeps the city the same on every load, so a still frame never jumps.
let seed = 2077;
function random() {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
}

function surface(w, h) {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(w, h);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

/** One row of towers along `base`, windows lit at random; records flickers and signs. */
function towers(g, base, minH, maxH, body, windowAlpha, near) {
  let x = -10;
  while (x < width + 10) {
    const w = 26 + random() * (near ? 70 : 46);
    const h = minH + random() * (maxH - minH);
    const top = base - h;
    g.fillStyle = body;
    g.fillRect(x, top, w, h + 2);
    // A spire or a stepped crown on some towers.
    if (random() < 0.3) g.fillRect(x + w * 0.4, top - h * 0.12, w * 0.2, h * 0.12);
    if (random() < 0.25) g.fillRect(x + w * 0.15, top - 8, w * 0.7, 8);

    const cols = Math.max(2, Math.floor(w / 7));
    const rows = Math.floor(h / 9);
    for (let r = 1; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (random() > (near ? 0.22 : 0.3)) continue;
        const wx = x + 3 + c * ((w - 6) / cols);
        const wy = top + r * 9;
        const warm = random() < 0.35;
        g.globalAlpha = windowAlpha * (0.4 + 0.6 * random());
        g.fillStyle = warm ? "#FFC27A" : random() < 0.5 ? "#7FE9FF" : "#E79BFF";
        g.fillRect(wx, wy, 2.4, 3);
        if (near && flickers < maxFlicker && random() < 0.08) {
          flickX[flickers] = wx;
          flickY[flickers] = wy;
          flickW[flickers] = 2.4;
          flickPhase[flickers] = random() * 1000;
          flickers++;
        }
      }
    }
    g.globalAlpha = 1;

    if (near && signs < maxSigns && w > 40 && random() < 0.55) {
      const vertical = random() < 0.6;
      signW[signs] = vertical ? 5 + random() * 4 : w * (0.5 + random() * 0.3);
      signH[signs] = vertical ? h * (0.25 + random() * 0.25) : 5 + random() * 3;
      signX[signs] = vertical
        ? x + (random() < 0.5 ? 4 : w - 4 - signW[signs])
        : x + (w - signW[signs]) / 2;
      signY[signs] = top + 14 + random() * Math.max(10, h * 0.3);
      signPhase[signs] = random() * 10000;
      signColour[signs] = signColours[signs % signColours.length];
      signs++;
    }
    x += w + 2 + random() * (near ? 10 : 6);
  }
}

function paintCity() {
  seed = 2077;
  flickers = 0;
  signs = 0;
  city = surface(Math.round(width * ratio), Math.round(height * ratio));
  const g = city.getContext("2d", { alpha: false });
  g.setTransform(ratio, 0, 0, ratio, 0, 0);

  // Sky: near black overhead, bruised violet lower down, a magenta smog line over the horizon.
  const sky = g.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, "#07060C");
  sky.addColorStop(0.45, "#0E0A1A");
  sky.addColorStop(0.72, "#2A0F33");
  sky.addColorStop(0.82, "#3D1238");
  sky.addColorStop(1, "#0B0912");
  g.fillStyle = sky;
  g.fillRect(0, 0, width, height);

  // Searchlight beams far off, very faint.
  g.globalAlpha = 0.05;
  g.fillStyle = cyan;
  for (let i = 0; i < 3; i++) {
    const bx = width * (0.2 + 0.3 * i + random() * 0.1);
    g.beginPath();
    g.moveTo(bx - 6, height * 0.78);
    g.lineTo(bx + 6, height * 0.78);
    g.lineTo(bx + 120 - 240 * random(), 0);
    g.lineTo(bx + 60 - 240 * random(), 0);
    g.closePath();
    g.fill();
  }
  g.globalAlpha = 1;

  const horizon = height * 0.8;
  towers(g, horizon + 20, height * 0.12, height * 0.34, "#140E22", 0.35, false);

  // Haze between the rows.
  const haze = g.createLinearGradient(0, horizon - height * 0.25, 0, horizon + 30);
  haze.addColorStop(0, "rgba(255,45,149,0)");
  haze.addColorStop(1, "rgba(255,45,149,0.14)");
  g.fillStyle = haze;
  g.fillRect(0, horizon - height * 0.25, width, height * 0.25 + 30);

  towers(g, height + 4, height * 0.18, height * 0.5, "#07050C", 0.8, true);

  // Wet street glow along the bottom edge.
  const street = g.createLinearGradient(0, height - 40, 0, height);
  street.addColorStop(0, "rgba(61,242,255,0)");
  street.addColorStop(1, "rgba(61,242,255,0.10)");
  g.fillStyle = street;
  g.fillRect(0, height - 40, width, 40);

  // Scanlines, very faint, so the city reads as a feed. Painted once, never per frame.
  g.globalAlpha = 0.06;
  g.fillStyle = "#000";
  for (let y = 0; y < height; y += 3) g.fillRect(0, y, width, 1);
  g.globalAlpha = 1;
}

function seedRain() {
  drops = Math.max(60, Math.min(maxDrops, Math.round((width * height) / 7000)));
  for (let i = 0; i < drops; i++) {
    dropX[i] = random() * (width + 80);
    dropY[i] = random() * height;
    dropLen[i] = 8 + random() * 16;
    dropSpeed[i] = 0.6 + 0.4 * random();
  }
}

function size(view) {
  if (typeof view.reduceMotion === "boolean") still = view.reduceMotion;
  width = view.width;
  height = view.height;
  ratio = Math.min(1.5, view.pixelRatio);
  view.canvas.width = Math.round(width * ratio);
  view.canvas.height = Math.round(height * ratio);
  ctx = view.canvas.getContext("2d", { alpha: false });
  paintCity();
  seedRain();
}

const fade = (since, length) => (since >= 0 && since < length ? 1 - since / length : 0);

function drawSigns(time, merged, waiting) {
  for (let i = 0; i < signs; i++) {
    // Most of the time a sign hums; now and then it stutters off for a beat.
    const t = (time + signPhase[i]) % 9000;
    const stutter = !still && t > 8600 && t % 120 < 60;
    let glow = stutter ? 0.15 : 0.85;
    let colour = signColour[i];
    if (i === 0 && waiting > 0) {
      colour = amber;
      glow = 0.5 + 0.5 * Math.abs(Math.sin(time / 260));
    }
    glow = Math.min(1, glow + merged);
    ctx.fillStyle = colour;
    ctx.globalAlpha = 0.12 * glow;
    ctx.fillRect(signX[i] - 6, signY[i] - 6, signW[i] + 12, signH[i] + 12);
    ctx.globalAlpha = 0.25 * glow;
    ctx.fillRect(signX[i] - 2, signY[i] - 2, signW[i] + 4, signH[i] + 4);
    ctx.globalAlpha = 0.95 * glow;
    ctx.fillRect(signX[i], signY[i], signW[i], signH[i]);
  }
}

function drawRain(dt, working) {
  const fall = still ? 0 : (dt / 1000) * (520 + 380 * working);
  ctx.strokeStyle = "#9FEFFF";
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.16;
  ctx.beginPath();
  for (let i = 0; i < drops; i++) {
    let y = dropY[i] + fall * dropSpeed[i];
    let x = dropX[i] - fall * dropSpeed[i] * 0.18;
    if (y > height) {
      y -= height + 30;
      x = random() * (width + 80);
    }
    dropX[i] = x;
    dropY[i] = y;
    ctx.moveTo(x, y);
    ctx.lineTo(x - dropLen[i] * 0.18, y + dropLen[i]);
  }
  ctx.stroke();
}

/** Shift a few horizontal bands sideways and tint them: a broken feed for a moment. */
function drawGlitch(strength, red) {
  const bands = 3 + Math.floor(strength * 5);
  for (let i = 0; i < bands; i++) {
    const y = random() * height;
    const h = 2 + random() * (6 + 20 * strength);
    const shift = (random() - 0.5) * 40 * strength;
    ctx.globalAlpha = 1;
    ctx.drawImage(city, 0, y * ratio, width * ratio, h * ratio, shift, y, width, h);
    ctx.globalAlpha = 0.18 * strength;
    ctx.fillStyle = red ? "#FF3B3B" : random() < 0.5 ? magenta : cyan;
    ctx.fillRect(0, y, width, h);
  }
}

function draw(time) {
  const dt = last < 0 ? 0 : Math.min(100, time - last);
  last = time;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.drawImage(city, 0, 0);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

  const merged = still ? 0 : fade(time - mergedAt, 2200);
  const failed = still ? 0 : fade(time - failedAt, 700);
  const waiting = fade(time - waitingAt, 4000);
  const working = fade(time - workingAt, 6000);

  // Flickering windows over the near towers.
  ctx.fillStyle = "#FFE3A8";
  for (let i = 0; i < flickers; i++) {
    const on = still || Math.sin((time + flickPhase[i]) / 700) > -0.2;
    if (!on) continue;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(flickX[i], flickY[i], flickW[i], 3);
  }

  drawSigns(time, merged, waiting);
  drawRain(dt, working);

  if (merged > 0) {
    // A light sweeping left to right across the city.
    const sweep = (1 - merged) * (width + 300) - 150;
    const beam = ctx.createLinearGradient(sweep - 150, 0, sweep + 150, 0);
    beam.addColorStop(0, "rgba(61,242,255,0)");
    beam.addColorStop(0.5, `rgba(61,242,255,${0.16 * merged})`);
    beam.addColorStop(1, "rgba(61,242,255,0)");
    ctx.globalAlpha = 1;
    ctx.fillStyle = beam;
    ctx.fillRect(sweep - 150, height * 0.35, 300, height * 0.65);
  }

  if (!still) {
    if (time >= nextGlitch && glitchAt < nextGlitch) {
      glitchAt = time;
      nextGlitch = time + 9000 + random() * 14000;
    }
    const idle = fade(time - glitchAt, 220);
    if (failed > 0) drawGlitch(failed, true);
    else if (idle > 0) drawGlitch(0.5 * idle, false);
  }

  ctx.globalAlpha = 1;
}

ace.scene({
  init(view) {
    size(view);
  },
  frame(time) {
    draw(time);
  },
  resize(view) {
    size(view);
    if (still) draw(last < 0 ? 0 : last);
  },
  motion(reduce) {
    still = reduce;
  },
  signal(name) {
    const now = last < 0 ? 0 : last;
    if (name === "pr-merged") mergedAt = now;
    else if (name === "failed") failedAt = now;
    else if (name === "waiting") waitingAt = now;
    else if (name === "working") workingAt = now;
  },
  scheme() {
    // Dark only: the city stays at night.
  },
});
