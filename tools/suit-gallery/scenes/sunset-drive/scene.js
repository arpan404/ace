/* global ace */
// Sunset Drive: a banded sun sinking behind layered ridges, an endless neon grid rolling toward
// the viewer, and a warm haze along the horizon. One fragment shader pass.
//   working: the grid rolls a little faster and its lines brighten.
//   waiting: the sun warms toward amber and its glow swells for a few seconds.
//   failed: the colour drains toward cool violet and the lines dim, then return.
//   pr-merged: a band of light runs along the grid toward you and the sun flares; done is a small glow.

const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
/** 0 → 1 over `rise` ms, held `hold` ms, back to 0 over `fall` ms. `age` is ms since. */
const swell = (age, rise, hold, fall) =>
  age < 0 ? 0 : age < rise + hold ? ease(age / rise) : 1 - ease((age - rise - hold) / fall);

(() => {
  "use strict";

  /** Backing pixels per device pixel; the browser scales the canvas up smoothly. */
  const DETAIL = 0.5;
  /** At most this many backing pixels, whatever the window. */
  const MAX_PIXELS = 1_400_000;
  /** Scene seconds of the still frame drawn under Reduce motion. */
  const STILL = 26;
  /** How much quicker the scene moves while agents work. */
  const SPEEDUP = 0.7;

  const VERTEX = `#version 300 es
in vec2 corner;
void main() { gl_Position = vec4(corner, 0.0, 1.0); }`;

  const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 res;
uniform float time;
uniform vec4 mood; // working, waiting, failed, flare: each 0..1
uniform vec2 burst; // x: seconds since pr-merged
out vec4 outColor;

uint mixBits(uint x) {
  x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
  return x;
}
uint cellBits(ivec2 c) { return mixBits(uint(c.x) * 0x9e3779b9u ^ mixBits(uint(c.y) + 0x632be5abu)); }
float hash(ivec2 c) { return float(cellBits(c)) * (1.0 / 4294967296.0); }
vec2 hash2(ivec2 c) {
  uint h = cellBits(c);
  return vec2(float(h & 0xffffu), float(h >> 16)) * (1.0 / 65535.0);
}
vec2 gradient(ivec2 c) { return hash2(c) * 2.0 - 1.0; }
// Gradient noise, about -0.7..0.7.
float noise(vec2 p) {
  ivec2 i = ivec2(floor(p));
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(gradient(i), f);
  float b = dot(gradient(i + ivec2(1, 0)), f - vec2(1.0, 0.0));
  float c = dot(gradient(i + ivec2(0, 1)), f - vec2(0.0, 1.0));
  float d = dot(gradient(i + ivec2(1, 1)), f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// Close to sRGB's curve, for picking colours by eye and lighting them linearly.
vec3 srgb(vec3 c) { return c * c * (c * 0.3 + 0.7); }
// Light to screen: a soft shoulder, back to display values, and a static dither so dark
// gradients never band.
vec4 finish(vec3 col) {
  col = 1.0 - exp(-max(col, 0.0) * 1.15);
  col = sqrt(col) * (0.92 + 0.08 * col);
  col += (hash(ivec2(gl_FragCoord.xy)) - 0.5) / 255.0;
  return vec4(col, 1.0);
}

float ridge(float x, float seed) {
  float h = 0.0, amp = 0.55, freq = 1.0;
  for (int i = 0; i < 4; i++) {
    float n = 1.0 - abs(noise(vec2(x * freq, seed + float(i) * 5.1)) * 1.6);
    h += n * n * amp;
    amp *= 0.45; freq *= 2.1;
  }
  return h;
}

// An anti-aliased grid line: 1 on the line, fading over about a pixel either side.
float gridLine(float w, float width) {
  float d = abs(fract(w - 0.5) - 0.5);
  float px = fwidth(w);
  return 1.0 - smoothstep(width * px, (width + 1.5) * px, d);
}

void main() {
  vec2 uv = gl_FragCoord.xy / res;
  vec2 p = vec2((gl_FragCoord.x - 0.5 * res.x) / res.y, uv.y);
  float t = time;
  float horizon = 0.40;
  float warm = mood.y;
  float drain = mood.z;
  float flare = mood.w;
  vec3 col;

  // The sun's place: low over the ridges, sinking and rising again over minutes.
  vec2 sunAt = vec2(0.0, horizon + 0.15 + 0.015 * sin(t * 0.01));
  float sunR = 0.215;
  float toSun = length(p - sunAt);

  if (uv.y >= horizon) {
    // Sky: indigo overhead, magenta, then a hot band at the horizon.
    float h = (uv.y - horizon) / (1.0 - horizon);
    col = mix(srgb(vec3(0.98, 0.44, 0.38)), srgb(vec3(0.52, 0.12, 0.42)), smoothstep(0.0, 0.32, h));
    col = mix(col, srgb(vec3(0.10, 0.04, 0.20)), smoothstep(0.25, 0.85, h));
    col = mix(col, srgb(vec3(0.035, 0.02, 0.09)), smoothstep(0.7, 1.0, h));
    col *= 0.62;
    // a few stars high up
    vec2 sq = p * 46.0;
    ivec2 sc = ivec2(floor(sq));
    float pick = hash(sc);
    float sd = length(fract(sq) - 0.2 - hash2(sc) * 0.6) * res.y / 46.0;
    col += vec3(1.0, 0.9, 0.95) * exp(-sd * sd * 1.2) * smoothstep(0.93, 1.0, pick) * smoothstep(0.45, 0.9, h) * 0.5;

    // The sun: yellow at its crown to rose at its foot, cut by bands that widen as they fall.
    float glowR = toSun / sunR;
    vec3 sunTop = srgb(mix(vec3(1.0, 0.80, 0.30), vec3(1.0, 0.62, 0.22), warm * 0.7)) * 1.45;
    vec3 sunMid = srgb(vec3(1.0, 0.40, 0.36)) * 1.3;
    vec3 sunFoot = srgb(vec3(0.95, 0.16, 0.50)) * 1.15;
    float sy = (p.y - (sunAt.y - sunR)) / (2.0 * sunR);
    vec3 sunCol = mix(sunFoot, sunMid, smoothstep(0.0, 0.5, sy));
    sunCol = mix(sunCol, sunTop, smoothstep(0.45, 1.0, sy));
    float below = clamp((sunAt.y + sunR * 0.3 - p.y) / (sunR * 1.3), 0.0, 1.0);
    float bandY = p.y * 26.0 + t * 0.08;
    float gap = mix(0.08, 0.75, below);
    float band = smoothstep(gap - 0.04, gap + 0.04, abs(fract(bandY) - 0.5) * 2.0);
    band = mix(1.0, band, step(0.001, below));
    float disc = 1.0 - smoothstep(sunR - 1.2 / res.y, sunR + 1.2 / res.y, toSun);
    col += srgb(vec3(1.0, 0.32, 0.45)) * exp(-max(glowR - 1.0, 0.0) * 2.4) * 0.22 * (1.0 + 0.6 * warm + 1.4 * flare);
    col = mix(col, sunCol * (1.0 + 0.5 * flare), disc * band);

    // Two ridges in front of the sun; light spills over the crests nearest it.
    float farRidge = horizon + 0.015 + 0.13 * ridge(p.x * 1.5 + 4.0, 3.0);
    float nearRidge = horizon - 0.01 + 0.08 * ridge(p.x * 1.1 - 7.0, 9.0) + 0.02 * smoothstep(0.2, 1.2, abs(p.x));
    float px = 1.2 / res.y;
    float rimFar = exp(-max(farRidge - uv.y, 0.0) * res.y * 0.25) * exp(-abs(p.x - sunAt.x) * 2.2);
    vec3 hazeCol = srgb(vec3(0.62, 0.20, 0.36));
    float low = 1.0 - smoothstep(horizon, horizon + 0.07, uv.y);
    vec3 farCol = srgb(vec3(0.22, 0.07, 0.26)) + srgb(vec3(1.0, 0.45, 0.55)) * rimFar * 0.5;
    farCol = mix(farCol, hazeCol, low * 0.55);
    col = mix(col, farCol, 1.0 - smoothstep(farRidge - px, farRidge + px, uv.y));
    float rimNear = exp(-max(nearRidge - uv.y, 0.0) * res.y * 0.4);
    vec3 nearCol = srgb(vec3(0.085, 0.028, 0.12)) + srgb(vec3(1.0, 0.30, 0.70)) * rimNear * 0.45;
    nearCol = mix(nearCol, hazeCol * 0.8, low * 0.45);
    col = mix(col, nearCol, 1.0 - smoothstep(nearRidge - px, nearRidge + px, uv.y));
  } else {
    // The floor: a grid in perspective, rolling toward the viewer.
    float dy = horizon - uv.y;
    float z = 0.11 / dy;
    float wx = p.x * z * 3.2;
    float wz = z * 3.2 + t * 0.55;
    float fade = exp(-z * 0.32) * (0.55 + 0.45 * smoothstep(0.02, 0.2, dy));
    float lines = max(gridLine(wx, 0.6), gridLine(wz, 0.6));
    // lines that crowd closer than a pixel near the horizon melt into the haze
    lines *= 1.0 - smoothstep(0.25, 0.6, max(fwidth(wx), fwidth(wz)));
    float softLines = max(exp(-abs(fract(wx - 0.5) - 0.5) * 22.0), exp(-abs(fract(wz - 0.5) - 0.5) * 22.0));
    vec3 lineCol = mix(srgb(vec3(1.0, 0.22, 0.78)), srgb(vec3(0.55, 0.45, 1.0)), drain * 0.8);
    col = srgb(vec3(0.06, 0.015, 0.09)) * (0.6 + 0.4 * (1.0 - smoothstep(0.0, 0.25, dy)));
    col = mix(col, srgb(vec3(0.62, 0.20, 0.36)) * 0.8, exp(-dy * 38.0) * 0.6);
    float bright = (0.85 + 0.25 * mood.x) * (1.0 - 0.5 * drain);
    // pr-merged: a band of light running in along the grid
    float pulseZ = 9.0 - burst.x * 2.6;
    float pulse = flare * exp(-abs(z - pulseZ) * 1.6) * step(0.0, pulseZ + 0.5);
    col += lineCol * (lines * 0.55 + softLines * 0.10) * fade * bright * (1.0 + 2.5 * pulse);
    col += srgb(vec3(1.0, 0.4, 0.8)) * pulse * 0.10 * fade;
    // the sun's reflection, a soft column on the floor
    col += srgb(vec3(1.0, 0.36, 0.48)) * exp(-abs(p.x - sunAt.x) * 5.0) * exp(-dy * 9.0) * 0.18 * (1.0 + warm + flare);
  }

  // One colour at the horizon itself, so ridge and floor meet without a seam.
  col = mix(col, srgb(vec3(0.52, 0.17, 0.32)) * 0.75, exp(-abs(uv.y - horizon) * 70.0) * 0.75);

  // Haze along the horizon, over both.
  float haze = exp(-abs(uv.y - horizon) * 22.0);
  col += srgb(vec3(1.0, 0.40, 0.50)) * haze * 0.16 * (1.0 + 0.5 * warm + flare);

  float grey = dot(col, vec3(0.3, 0.5, 0.2));
  col = mix(col, vec3(grey) * vec3(0.8, 0.8, 1.05), drain * 0.55);
  col *= 1.0 - 0.3 * smoothstep(0.55, 1.25, length((uv - 0.5) * vec2(res.x / res.y, 1.0)));
  outColor = finish(col);
}`;

  let gl = null;
  let uniforms = null;
  let last = -1;
  let now = 0;
  let flow = STILL;
  let work = 0;
  let workUntil = -Infinity;
  let waitAt = -Infinity;
  let failAt = -Infinity;
  let mergeAt = -Infinity;
  let doneAt = -Infinity;

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw new Error(`sunset-drive shader: ${gl.getShaderInfoLog(shader)}`);
    return shader;
  }

  function build() {
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.bindAttribLocation(program, 0, "corner");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(`sunset-drive program: ${gl.getProgramInfoLog(program)}`);
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    uniforms = {};
    for (const name of ["res", "time", "mood", "burst"])
      uniforms[name] = gl.getUniformLocation(program, name);
  }

  function fit(view) {
    let scale = Math.min(view.pixelRatio, Math.max(0.75, view.pixelRatio * DETAIL));
    const pixels = view.width * view.height * scale * scale;
    if (pixels > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / pixels);
    view.canvas.width = Math.max(1, Math.round(view.width * scale));
    view.canvas.height = Math.max(1, Math.round(view.height * scale));
  }

  ace.scene({
    init(view) {
      gl = view.canvas.getContext("webgl2", {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        // ace's live contrast check reads the canvas between frames.
        preserveDrawingBuffer: true,
        powerPreference: "low-power",
      });
      if (!gl) throw new Error("sunset-drive needs WebGL 2");
      view.canvas.addEventListener("webglcontextlost", (event) => event.preventDefault());
      view.canvas.addEventListener("webglcontextrestored", build);
      fit(view);
      build();
    },
    resize(view) {
      fit(view);
    },
    frame(time, view) {
      if (!uniforms || gl.isContextLost()) return;
      const dt = last < 0 ? 0 : Math.min(Math.max(time - last, 0), 100);
      last = time;
      now = time;
      work += ((time < workUntil ? 1 : 0) - work) * (1 - Math.exp(-dt / 2500));
      flow += (dt / 1000) * (1 + SPEEDUP * work);
      const still = view.reduceMotion;
      const t = still ? STILL : flow;
      const working = still ? 0 : work;
      const waiting = still ? 0 : swell(time - waitAt, 1500, 3500, 3000);
      const failed = still ? 0 : swell(time - failAt, 900, 2200, 3200);
      const flare = still
        ? 0
        : Math.max(
            swell(time - mergeAt, 1400, 2600, 4500),
            0.3 * swell(time - doneAt, 900, 400, 2200),
          );
      gl.uniform2f(uniforms.burst, still ? 0 : Math.max(0, (time - mergeAt) / 1000), 0);

      gl.viewport(0, 0, view.canvas.width, view.canvas.height);
      gl.uniform2f(uniforms.res, view.canvas.width, view.canvas.height);
      gl.uniform1f(uniforms.time, t);
      gl.uniform4f(uniforms.mood, working, waiting, failed, flare);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    signal(name) {
      if (name === "working") workUntil = now + 45_000;
      else if (name === "waiting") waitAt = now;
      else if (name === "failed") failAt = now;
      else if (name === "pr-merged") mergeAt = now;
      else if (name === "done") doneAt = now;
      if (name !== "working") workUntil = Math.min(workUntil, now + 8000);
    },
  });
})();
