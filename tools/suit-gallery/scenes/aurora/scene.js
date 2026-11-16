/* global ace */
// Aurora: soft ribbons of light folding slowly over a night sky, above moonlit snowy ridges,
// under three depths of stars. One fragment shader pass at reduced resolution.
//   working: the ribbons drift a little quicker and brighter.
//   waiting: their upper edges warm to rose for a few seconds.
//   failed: the light dims and cools, then returns.
//   pr-merged: the aurora flares bright and tall for a few seconds; done is a small glow.

const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
/** 0 → 1 over `rise` ms, held `hold` ms, back to 0 over `fall` ms. `age` is ms since. */
const swell = (age, rise, hold, fall) =>
  age < 0 ? 0 : age < rise + hold ? ease(age / rise) : 1 - ease((age - rise - hold) / fall);

(() => {
  "use strict";

  /** Backing pixels per device pixel; the browser scales the canvas up smoothly. */
  const DETAIL = 0.375;
  /** Never fewer backing pixels per CSS pixel than this, even on a 1x display. */
  const MIN_SCALE = 0.75;
  /** At most this many backing pixels, whatever the window. */
  const MAX_PIXELS = 1_400_000;
  /** Scene seconds of the still frame drawn under Reduce motion. */
  const STILL = 71;
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

float ridge(float x, float seed, int octaves) {
  float h = 0.0, amp = 0.55, freq = 1.0, weight = 1.0;
  for (int i = 0; i < 5; i++) {
    if (i >= octaves) break;
    float n = 1.0 - abs(noise(vec2(x * freq, seed + float(i) * 7.3)) * 1.6);
    n *= n;
    h += n * amp * weight;
    weight = clamp(n * 1.4, 0.0, 1.0); // detail gathers on the crests
    amp *= 0.45; freq *= 2.2;
  }
  return h;
}

vec3 stars(vec2 p, float t) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float cells = 26.0 + fi * 20.0;          // far layers have more, smaller stars
    float drift = 0.0042 - fi * 0.0012;      // and move slower: parallax
    vec2 q = (p + vec2(t * drift, 0.0)) * cells;
    ivec2 c = ivec2(floor(q)) + ivec2(i * 913, i * 377);
    vec2 f = fract(q);
    vec2 at = 0.2 + hash2(c) * 0.6;
    float pick = hash(c + ivec2(17, 3));
    float magnitude = pow(smoothstep(0.86 + fi * 0.035, 1.0, pick), 1.6) * (1.0 - fi * 0.3);
    float px = res.y / cells;                // cell size in backing pixels
    float d = length(f - at) * px;
    float twinkle = 0.78 + 0.22 * sin(t * (0.35 + 0.9 * hash(c + ivec2(5, 9))) + pick * 40.0);
    float core = exp(-d * d * (1.4 - fi * 0.3));
    float halo = exp(-d * 0.55) * 0.05 * step(0.93, pick);
    vec3 tint = mix(vec3(0.72, 0.82, 1.0), vec3(1.0, 0.88, 0.74), hash(c + ivec2(2, 41)));
    sum += tint * magnitude * twinkle * (core + halo) * 1.6;
  }
  return sum;
}
// One ribbon of aurora: a soft lower edge feathered both ways, a long glow rising from it
// that fades out smoothly, folds that gather light, and slow breaks along its length.
vec3 ribbon(vec2 p, float t, float seed, float scale, float base, float amp,
            float edge, float tail, float bright, out float activity) {
  float x = p.x * scale;
  float warp = noise(vec2(x * 0.42 - seed, t * 0.014 + seed)) * 0.9;
  float xf = x + warp;
  float warp2 = noise(vec2((x + 0.02) * 0.42 - seed, t * 0.014 + seed)) * 0.9;
  float stretch = abs((0.02 + warp2 - warp) / 0.02);
  float gather = 1.0 + 0.8 * exp(-stretch * 1.6); // folds catch more light
  float centre = base + amp * (0.7 * sin(xf * 1.3 + seed * 2.0 + t * 0.018)
                            + 0.9 * noise(vec2(xf * 0.7 + seed * 3.0, t * 0.022)));
  float d = p.y - centre;
  // broad pleats: the glow rises taller in some folds than others
  float pleat = smoothstep(-0.35, 0.45, noise(vec2(xf * 2.4 + seed, t * 0.03)));
  tail *= 0.55 + 0.9 * pleat;
  float below = d < 0.0 ? exp(-(d * d) / (edge * edge)) : 1.0;
  float above = d > 0.0 ? exp(-d / tail) * exp(-(d * d) / (tail * tail * 6.0)) : 1.0;
  activity = smoothstep(-0.32, 0.42, noise(vec2(xf * 0.45 + seed * 5.0, t * 0.018)));
  float shimmer = (0.7 + 0.3 * pleat) * (0.85 + 0.15 * noise(vec2(xf * 5.0, d * 0.5 - t * 0.025 + seed)));
  float light = bright * below * above * activity * gather * shimmer;

  float hue = smoothstep(-0.3, 0.3, noise(vec2(xf * 0.3 + seed, 7.0)));
  vec3 green = mix(srgb(vec3(0.22, 0.95, 0.60)), srgb(vec3(0.16, 0.85, 0.78)), hue * 0.6);
  vec3 teal = srgb(vec3(0.12, 0.62, 0.72));
  vec3 violet = srgb(vec3(0.45, 0.28, 0.80));
  vec3 rose = srgb(vec3(0.90, 0.45, 0.60));
  vec3 tint = mix(green, teal, smoothstep(0.0, tail * 1.4, d));
  tint = mix(tint, mix(violet, rose, mood.y * 0.7), smoothstep(tail * 0.9, tail * 3.0, d) * 0.85);
  tint = mix(tint, srgb(vec3(0.25, 0.45, 0.95)), mood.z * 0.5);
  return tint * light;
}

// A mountain range under the moon: a clear silhouette, snow on the crests, a thin moonlit rim
// along the ridge line, and the colour of the air the further away it is.
vec3 range(vec3 col, vec2 p, float y, float base, float amp, float scale, float seed,
           vec3 body, vec3 air, float distance, vec3 glow) {
  float x = p.x * scale + seed;
  float h = base + amp * ridge(x, seed, 5);
  float px = 1.2 / res.y;
  float mask = smoothstep(-px, px, h - y);
  if (mask <= 0.0) return col;
  float e = 0.045;
  float slope = (ridge(x + e, seed, 2) - ridge(x - e, seed, 2)) * amp / (2.0 * e / scale);
  float below = max(h - y, 0.0);
  float lit = clamp(0.5 + slope * 0.6, 0.1, 1.0); // the moon is up to the right
  // snow shows on the faces the moon reaches, palest near the crest; the shadow side stays dark
  float snow = exp(-below * 28.0) * lit * lit;
  vec3 c = body * (0.9 + 0.35 * lit * exp(-below * 14.0));
  c = mix(c, srgb(vec3(0.24, 0.29, 0.40)) + glow, snow * 0.7);
  float rim = exp(-below * res.y * 0.6) * (0.25 + 0.75 * lit);
  c += (srgb(vec3(0.62, 0.72, 0.90)) * 0.30 + glow * 0.8) * rim;
  c = mix(c, air, distance);
  return mix(col, c, mask);
}

void main() {
  vec2 uv = gl_FragCoord.xy / res.y;
  float aspect = res.x / res.y;
  vec2 p = vec2(uv.x - aspect * 0.5, uv.y);
  float t = time;
  float flare = mood.w;
  float dim = 1.0 - 0.45 * mood.z;

  // Night sky: deep blue, lighter toward the horizon, three depths of stars, a small moon.
  vec3 col = mix(srgb(vec3(0.045, 0.075, 0.12)), srgb(vec3(0.012, 0.016, 0.045)), smoothstep(0.08, 1.0, uv.y));
  col += stars(p, t) * smoothstep(0.2, 0.5, uv.y);
  vec2 moon = vec2(aspect * 0.36, 0.86);
  float toMoon = length(p - moon);
  col += srgb(vec3(0.75, 0.82, 0.95)) * (exp(-toMoon * 14.0) * 0.06 + exp(-toMoon * 4.0) * 0.015);
  float r = toMoon / 0.017;
  float face = 0.86 + 0.14 * noise((p - moon) * 160.0) + 0.06 * noise((p - moon) * 60.0 + 3.0);
  vec3 moonCol = srgb(vec3(0.95, 0.95, 0.92)) * face * (1.0 - 0.25 * r * r) * 1.6;
  col = mix(col, moonCol, 1.0 - smoothstep(0.9, 1.05, r));

  // Three ribbons, near to far.
  float amount = (1.0 + 0.2 * mood.x + 0.35 * flare) * dim;
  float reach = 1.0 + 0.6 * flare; // the flare reaches higher more than it brightens
  float a1, a2, a3;
  vec3 aurora = ribbon(p, t, 1.7, 0.9, 0.52, 0.15, 0.03, 0.15 * reach, 0.66, a1);
  aurora += ribbon(p, t * 0.85, 9.2, 1.3, 0.66, 0.10, 0.022, 0.10 * reach, 0.34, a2);
  aurora += ribbon(p, t * 0.7, 4.4, 1.9, 0.77, 0.07, 0.016, 0.07 * reach, 0.16, a3);
  col += aurora * amount;
  // the sky around them glows faintly with their light
  vec3 green = srgb(vec3(0.20, 0.90, 0.62));
  col += green * 0.03 * exp(-abs(uv.y - 0.58) * 3.5) * smoothstep(0.25, 0.5, uv.y) * (0.6 * a1 + 0.4 * a2) * amount;

  // Three ranges, far to near, each a clear step darker, all touched by the green light.
  vec3 light = green * a1 * amount;
  vec3 air = srgb(vec3(0.06, 0.09, 0.14));
  col = range(col, p, uv.y, 0.25, 0.20, 2.1, 11.0, srgb(vec3(0.075, 0.10, 0.15)), air, 0.35, light * 0.10);
  col = range(col, p, uv.y, 0.14, 0.19, 1.5, 3.0, srgb(vec3(0.040, 0.055, 0.085)), air, 0.12, light * 0.07);
  col = range(col, p, uv.y, 0.02, 0.15, 1.05, 23.0, srgb(vec3(0.016, 0.020, 0.034)), air, 0.0, light * 0.05);
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
      throw new Error(`aurora shader: ${gl.getShaderInfoLog(shader)}`);
    return shader;
  }

  function build() {
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.bindAttribLocation(program, 0, "corner");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(`aurora program: ${gl.getProgramInfoLog(program)}`);
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    uniforms = {};
    for (const name of ["res", "time", "mood"])
      uniforms[name] = gl.getUniformLocation(program, name);
  }

  function fit(view) {
    let scale = Math.min(view.pixelRatio, Math.max(MIN_SCALE, view.pixelRatio * DETAIL));
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
      if (!gl) throw new Error("aurora needs WebGL 2");
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
