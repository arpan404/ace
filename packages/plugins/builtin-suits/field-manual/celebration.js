// Field Manual's celebration: an inspector's rubber stamp slams onto the page. It drops in from
// above the glass, strikes (a short squash and a jolt), and the ink spreads a hair into the
// paper while the impression darkens; it rests, then lifts away. A finished run is stamped
// INSPECTED, a merged pull request APPROVED. The whole moment is 3.1 s; afterwards the canvas is
// clear and it calls ace.finish(). ace never plays it under Reduce motion.
// The stamp is drawn once per size onto two offscreen canvases (the crisp impression and its ink
// spread, both worn by a fixed speckle of missing ink); each frame only clears and blits them.

const dropMs = 230;
const strikeMs = 140;
const spreadMs = 520;
const fadeFrom = 2350;
const fadeMs = 750;
const endMs = fadeFrom + fadeMs;

let ctx = null;
let width = 1;
let height = 1;
let ratio = 1;
let scheme = "light";
let still = false;
let word = "INSPECTED";
let startAt = null;
let over = true;
let crisp = null;
let spread = null;
let stampW = 1;
let stampH = 1;
let builtFor = "";

let seed = 41;
function random() {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
}

const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeIn = (p) => p * p * p;
const easeOut = (p) => 1 - (1 - p) * (1 - p);

function ink() {
  return scheme === "dark" ? "#f0814a" : "#b3341a";
}

function layer(w, h) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * ratio));
  canvas.height = Math.max(1, Math.round(h * ratio));
  const c = canvas.getContext("2d");
  return { canvas, c };
}

function frameRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.lineTo(x + w - r, y);
  c.quadraticCurveTo(x + w, y, x + w, y + r);
  c.lineTo(x + w, y + h - r);
  c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  c.lineTo(x + r, y + h);
  c.quadraticCurveTo(x, y + h, x, y + h - r);
  c.lineTo(x, y + r);
  c.quadraticCurveTo(x, y, x + r, y);
  c.closePath();
}

// The stamp's face: a double-ruled frame, the word in heavy condensed caps between two rules,
// the manual's number and the inspector's mark underneath.
function drawFace(c, grow) {
  const pad = 10 + grow;
  c.setTransform(ratio, 0, 0, ratio, 0, 0);
  c.clearRect(0, 0, stampW + pad * 2, stampH + pad * 2);
  c.strokeStyle = ink();
  c.fillStyle = ink();
  c.lineJoin = "round";
  c.lineWidth = 6 + grow * 2;
  frameRect(c, pad, pad, stampW, stampH, 10);
  c.stroke();
  c.lineWidth = 2 + grow * 2;
  frameRect(c, pad + 9, pad + 9, stampW - 18, stampH - 18, 5);
  c.stroke();
  const wordSize = Math.round(stampH * 0.4);
  c.font = `800 ${wordSize}px "Arial Narrow", "Helvetica Neue", Arial, sans-serif`;
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.lineWidth = grow * 2;
  const cx = pad + stampW / 2;
  const cy = pad + stampH * 0.47;
  c.fillText(word, cx, cy, stampW - 52);
  if (grow > 0) c.strokeText(word, cx, cy, stampW - 52);
  c.lineWidth = 1.6 + grow * 2;
  c.beginPath();
  c.moveTo(pad + 30, pad + stampH * 0.2);
  c.lineTo(pad + stampW - 30, pad + stampH * 0.2);
  c.moveTo(pad + 30, pad + stampH * 0.72);
  c.lineTo(pad + stampW - 30, pad + stampH * 0.72);
  c.stroke();
  c.font = `700 ${Math.round(stampH * 0.11)}px "Helvetica Neue", Arial, sans-serif`;
  c.fillText("FM 1-ACE  ·  QUALITY CONTROL  ·  No. 07", cx, pad + stampH * 0.83, stampW - 60);
  // Worn rubber: a fixed speckle of missing ink and a few dry streaks.
  seed = 41;
  c.globalCompositeOperation = "destination-out";
  for (let i = 0; i < 260; i++) {
    const x = pad + random() * stampW;
    const y = pad + random() * stampH;
    const r = 0.4 + random() * 1.5;
    c.globalAlpha = 0.35 + random() * 0.65;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
  }
  c.globalAlpha = 0.5;
  for (let i = 0; i < 7; i++) {
    const x = pad + random() * stampW;
    const y = pad + random() * stampH;
    c.fillRect(x, y, 18 + random() * 40, 0.8 + random() * 0.8);
  }
  c.globalAlpha = 1;
  c.globalCompositeOperation = "source-over";
}

function build() {
  const key = `${width}x${height}@${ratio}:${scheme}:${word}`;
  if (key === builtFor) return;
  builtFor = key;
  stampW = Math.round(Math.max(260, Math.min(460, width * 0.34)));
  stampH = Math.round(stampW * 0.36);
  crisp = layer(stampW + 20, stampH + 20);
  drawFace(crisp.c, 0);
  spread = layer(stampW + 24, stampH + 24);
  drawFace(spread.c, 1.2);
}

function size(view) {
  width = view.width;
  height = view.height;
  ratio = Math.min(2, view.pixelRatio || 1);
  scheme = view.scheme === "dark" ? "dark" : "light";
  if (typeof view.reduceMotion === "boolean") still = view.reduceMotion;
  ctx = view.canvas.getContext("2d");
}

function draw(time) {
  if (!ctx) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (over) return;
  if (startAt === null) startAt = time;
  const t = time - startAt;
  if (still || t >= endMs) {
    // Played out (or motion was turned off mid-way): clear, and let ace take the frame down.
    over = true;
    ace.finish();
    return;
  }
  build();
  const drop = easeIn(clamp(t / dropMs));
  const strike = clamp((t - dropMs) / strikeMs);
  const squash = strike > 0 && strike < 1 ? Math.sin(strike * Math.PI) * 0.04 : 0;
  const scale = (1.85 - 0.85 * drop) * (1 - squash);
  // The jolt of the strike: the impression shakes a pixel or two, once.
  const jolt = strike > 0 && strike < 1 ? Math.sin(strike * Math.PI * 3) * 2 * (1 - strike) : 0;
  const fade = 1 - easeOut(clamp((t - fadeFrom) / fadeMs));
  const lift = (1 - fade) * 18;
  const cx = width / 2 + jolt;
  const cy = height * 0.42 - lift;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-0.12);
  ctx.scale(scale, scale);
  // Falling, the stamp is a pale shadow of itself; it reads as ink only once it has struck.
  const struck = t >= dropMs;
  ctx.globalAlpha = (struck ? 0.92 : 0.25 + 0.45 * drop) * fade;
  const w = stampW + 20;
  const h = stampH + 20;
  ctx.drawImage(crisp.canvas, -w / 2, -h / 2, w, h);
  if (struck && spread) {
    // The ink bleeds a hair into the paper after the strike.
    ctx.globalAlpha = 0.32 * easeOut(clamp((t - dropMs) / spreadMs)) * fade;
    const sw = stampW + 24;
    const sh = stampH + 24;
    ctx.drawImage(spread.canvas, -sw / 2, -sh / 2, sw, sh);
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

ace.scene({
  init(view) {
    size(view);
  },
  resize(view) {
    size(view);
  },
  scheme(next) {
    scheme = next === "dark" ? "dark" : "light";
  },
  motion(reduceMotion) {
    still = reduceMotion;
  },
  frame(time, view) {
    if (typeof view.reduceMotion === "boolean") still = view.reduceMotion;
    draw(time);
  },
  signal(name) {
    // ace wakes it with "done" or "pr-merged"; the stamp falls on the next frame.
    if (name !== "done" && name !== "pr-merged") return;
    word = name === "pr-merged" ? "APPROVED" : "INSPECTED";
    startAt = null;
    over = false;
  },
});
