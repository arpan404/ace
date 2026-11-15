// Alpine Lodge's celebration: when the work is done or a pull request merges, an aurora flares
// across the sky above the lodge and a burst of snow sparkle drifts down through the window.
//
// It plays above the UI for about three seconds, on a clear canvas (only the light itself is
// drawn), then fades and tells ace it's finished. Ribbons of green, teal and a little violet
// sway along the top of the window; sparkles drift down from them.
//
// Cheap by construction: each ribbon's glow (a vertical gradient, brightest at its lower edge)
// is painted once into a thin sprite; a frame stretches that sprite into narrow columns
// at their swaying heights with one alpha each, then draws a couple of hundred small squares.

const length = 3200; // ms the moment lasts
const columns = 120;
let ctx = null;
let now = 0;
let startedAt = -1;
let finished = false;
let sparkles = [];
let ribbons = [];

let seed = 11;
function random() {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
}

// A ribbon's curtain of light: clear at the top, brightest near its lower edge, clear below.
function curtain(rgb) {
  const sprite = document.createElement("canvas");
  sprite.width = 4;
  sprite.height = 128;
  const g = sprite.getContext("2d");
  const fill = g.createLinearGradient(0, 0, 0, 128);
  fill.addColorStop(0, `rgba(${rgb},0)`);
  fill.addColorStop(0.55, `rgba(${rgb},0.45)`);
  fill.addColorStop(0.8, `rgba(${rgb},1)`);
  fill.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = fill;
  g.fillRect(0, 0, 4, 128);
  return sprite;
}

function build() {
  seed = 11;
  ribbons = [
    { y: 0.12, amp: 0.05, wave: 2.3, speed: 0.9, rgb: "110,236,170", height: 0.22, alpha: 0.6 },
    { y: 0.18, amp: 0.06, wave: 1.7, speed: 0.7, rgb: "80,214,204", height: 0.26, alpha: 0.46 },
    { y: 0.07, amp: 0.04, wave: 3.1, speed: 1.2, rgb: "176,140,244", height: 0.15, alpha: 0.36 },
    { y: 0.25, amp: 0.05, wave: 2.0, speed: 0.8, rgb: "150,244,196", height: 0.17, alpha: 0.32 },
  ].map((ribbon) => Object.assign(ribbon, { sprite: curtain(ribbon.rgb) }));
  sparkles = [];
  for (let i = 0; i < 200; i++) {
    sparkles.push({
      x: random(),
      y: random() * 0.3,
      delay: random() * 0.35,
      fall: 0.22 + random() * 0.4, // window heights per second
      sway: 0.004 + random() * 0.012,
      r: 1 + random() * 2.2,
      twinkle: random() * Math.PI * 2,
      warm: random() < 0.25,
    });
  }
}

function envelope(t) {
  // Rise over the first fifth, hold, fade over the last quarter.
  if (t < 0.2) return t / 0.2;
  if (t > 0.75) return Math.max(0, (1 - t) / 0.25);
  return 1;
}

function drawRibbons(w, h, seconds, strength) {
  const step = w / columns;
  for (const ribbon of ribbons) {
    for (let i = 0; i < columns; i++) {
      const u = i / columns;
      const phase = u * Math.PI * ribbon.wave + seconds * ribbon.speed * 2.4;
      const top = (ribbon.y + Math.sin(phase) * ribbon.amp) * h;
      const tall = ribbon.height * h * (0.7 + 0.3 * Math.sin(phase * 1.7 + 1));
      // A slow swell along the curtain, with a faint ray texture on top of it.
      const shimmer =
        0.62 +
        0.28 * Math.sin(u * 7 + seconds * 1.6 + ribbon.wave) +
        0.1 * Math.sin(u * 41 + seconds * 3);
      ctx.globalAlpha = Math.max(0, Math.min(1, ribbon.alpha * strength * shimmer));
      ctx.drawImage(ribbon.sprite, i * step, top, step + 1, tall);
    }
  }
  ctx.globalAlpha = 1;
}

function drawSparkles(w, h, seconds, strength) {
  for (const s of sparkles) {
    const local = seconds - s.delay * (length / 1000);
    if (local < 0) continue;
    const y = (s.y + local * s.fall) * h;
    if (y > h) continue;
    const x = (s.x + Math.sin(local * 2 + s.twinkle) * s.sway) * w;
    const twinkle = 0.55 + 0.45 * Math.sin(local * 9 + s.twinkle);
    ctx.globalAlpha = strength * twinkle;
    ctx.fillStyle = s.warm ? "#ffdeaa" : "#f0faff";
    ctx.fillRect(x - s.r / 2, y - s.r / 2, s.r, s.r);
    // The bigger flakes catch the light as a four-point glint.
    if (s.r > 2.4 && twinkle > 0.8) {
      ctx.fillRect(x - s.r * 2.2, y - 0.4, s.r * 4.4, 0.8);
      ctx.fillRect(x - 0.4, y - s.r * 2.2, 0.8, s.r * 4.4);
    }
  }
  ctx.globalAlpha = 1;
}

ace.scene({
  init(view) {
    ctx = view.canvas.getContext("2d");
    build();
  },
  signal(_name) {
    // "done" or "pr-merged": either one is a summit reached.
    if (startedAt < 0) startedAt = now;
  },
  frame(time, view) {
    now = time;
    if (finished) return;
    ctx.setTransform(view.pixelRatio, 0, 0, view.pixelRatio, 0, 0);
    ctx.clearRect(0, 0, view.width, view.height);
    if (startedAt < 0) return;
    const elapsed = time - startedAt;
    const t = elapsed / length;
    if (t >= 1 || view.reduceMotion) {
      finished = true;
      ace.finish();
      return;
    }
    const strength = envelope(t);
    drawRibbons(view.width, view.height, elapsed / 1000, strength);
    drawSparkles(view.width, view.height, elapsed / 1000, strength);
  },
});
