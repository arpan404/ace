/* global ace */
// Aurora: curtains of light folding slowly over a night sky, above snowy ridges, under three
// depths of stars. One fragment shader pass at reduced resolution.
//   working: the curtains drift a little quicker and brighter.
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
  /** At most this many backing pixels, whatever the window. */
  const MAX_PIXELS = 1_400_000;
  /** Scene seconds of the still frame drawn under Reduce motion. */
  const STILL = 71;
  /** How much quicker the scene drifts while agents work. */
  const SPEEDUP = 0.7;

  const VERTEX = `#version 300 es
in vec2 corner;
void main() { gl_Position = vec4(corner, 0.0, 1.0); }`;

  const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 res;
uniform float time;
uniform vec4 mood; // working, waiting, failed, flare
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
vec3 srgb(vec3 c) { return c * c * (c * 0.3 + 0.7); }

// A mountain ridge's height at x: sharp peaks from folded noise.
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

// One curtain: light hanging from a folded lower edge, streaked into rays.
vec3 curtain(vec2 p, float t, float seed, float scale, float base, float height,
             vec3 low, vec3 high, vec3 warm, float amount, out float activity) {
  float x = p.x * scale;
  float fold = noise(vec2(x * 0.5 + seed, t * 0.016 + seed)) * 1.15
             + noise(vec2(x * 1.3 - seed, t * 0.027 + 3.1)) * 0.38;
  float x2 = x + 0.012;
  float fold2 = noise(vec2(x2 * 0.5 + seed, t * 0.016 + seed)) * 1.15
              + noise(vec2(x2 * 1.3 - seed, t * 0.027 + 3.1)) * 0.38;
  float xf = x + fold * 0.75;
  float stretch = abs((x2 + fold2 * 0.75 - xf) / 0.012);
  float bunch = 1.0 + 1.3 * exp(-stretch * 2.2); // light gathers where the curtain folds

  // the lower edge sweeps in a long, slowly turning arc, with smaller folds along it
  float edge = base + 0.085 * sin(x * 1.25 + seed * 2.0 + t * 0.021)
                    + 0.30 * noise(vec2(xf * 0.7 + seed * 3.0, t * 0.03))
                    + 0.05 * noise(vec2(xf * 2.6 - seed, t * 0.05));
  float d = p.y - edge;
  float lower = smoothstep(-0.035, 0.012, d);
  float rise = exp(-max(d, 0.0) / height) * (1.0 - smoothstep(height * 1.2, height * 3.2, d));

  float rays = noise(vec2(xf * 21.0, seed + d * 0.9 - t * 0.05))
             + 0.55 * noise(vec2(xf * 57.0, seed * 2.0 + d * 1.7 - t * 0.08));
  rays = 0.42 + 0.58 * smoothstep(-0.45, 0.55, rays);

  activity = smoothstep(-0.12, 0.42, noise(vec2(xf * 0.65 + seed * 5.0, t * 0.022)));
  float glow = amount * lower * rise * rays * activity * bunch;

  float upper = smoothstep(0.0, height * 1.5, d);
  vec3 tint = mix(low, high, upper);
  tint = mix(tint, warm, mood.y * 0.55 * upper);
  // a faint rose fringe under the brightest edge
  tint += vec3(0.5, 0.08, 0.32) * exp(-abs(d + 0.006) * 140.0) * 0.35 * activity;
  return tint * glow;
}

// One mountain range over col: a ridge line with snow lit from the upper left, darker and
// sharper the nearer it is, mist gathering toward its foot.
vec3 range(vec3 col, vec2 p, float y, float base, float amp, float scale, float seed,
           vec3 body, float near, vec3 light, float snowAmount) {
  float x = p.x * scale + seed;
  float h = base + amp * ridge(x, seed, 5);
  float e2 = 0.02;
  float slope = (ridge(x + e2, seed, 2) - ridge(x - e2, seed, 2)) * amp / (2.0 * e2 / scale);
  float below = h - y;
  float px = 1.2 / res.y;
  float mask = smoothstep(-px, px, below);
  if (mask <= 0.0) return col;
  // broad faces from the low octaves, the crest's own facing near the top
  float face = slope;
  float lit = clamp(0.4 - face * 0.5, 0.05, 1.0) * (0.55 + 0.45 * exp(-max(below, 0.0) * 9.0));
  float drift = noise(vec2(x * 7.0 + below * 4.0, below * 11.0 + seed));
  float snowline = 0.05 + 0.06 * (0.5 + 0.5 * drift);
  float snow = (1.0 - smoothstep(0.0, snowline, below)) * smoothstep(-0.25, 0.2, drift + 0.12);
  vec3 snowCol = (srgb(vec3(0.17, 0.21, 0.29)) + light * 1.6) * lit * snowAmount;
  vec3 c = mix(body, snowCol, snow * 0.85);
  c += (srgb(vec3(0.6, 0.8, 0.95)) * 0.05 + light * 0.4) * exp(-max(below, 0.0) * res.y * 0.35) * lit * near;
  // valley mist: the foot of the range fades toward the air behind it
  float mist = smoothstep(base + amp * 0.35, base - 0.03, y) * (1.1 - near);
  c = mix(c, srgb(vec3(0.07, 0.10, 0.14)) + light * 0.25, mist * 0.55);
  return mix(col, c, mask);
}

void main() {
  vec2 uv = gl_FragCoord.xy / res.y;
  float aspect = res.x / res.y;
  vec2 p = vec2(uv.x - aspect * 0.5, uv.y);
  float t = time;
  float flare = mood.w;
  float dim = 1.0 - 0.45 * mood.z;

  // Sky: deep blue, a little lighter toward the horizon.
  vec3 col = mix(srgb(vec3(0.035, 0.06, 0.10)), srgb(vec3(0.012, 0.016, 0.045)), smoothstep(0.05, 1.0, uv.y));
  col += stars(p, t) * smoothstep(0.12, 0.45, uv.y);

  float amount = (1.0 + 0.18 * mood.x + 1.25 * flare) * dim;
  float reach = 1.0 + 0.3 * flare;
  vec3 green = mix(srgb(vec3(0.20, 0.95, 0.62)), srgb(vec3(0.25, 0.55, 0.95)), mood.z * 0.6);
  vec3 violet = srgb(vec3(0.48, 0.22, 0.78));
  vec3 rose = srgb(vec3(0.95, 0.42, 0.52));
  float act1, act2;
  vec3 aurora = curtain(p, t, 1.7, 1.0, 0.47, 0.20 * reach, green * 0.55, violet * 0.42, rose * 0.4, amount, act1);
  aurora += curtain(p, t * 0.8, 9.2, 1.45, 0.60, 0.13 * reach, srgb(vec3(0.15, 0.75, 0.70)) * 0.32, violet * 0.30, rose * 0.25, amount, act2);
  // the sky around the curtains glows faintly with their light
  float haze = exp(-abs(uv.y - 0.62) * 3.0) * smoothstep(0.3, 0.55, uv.y) * (0.6 * act1 + 0.4 * act2);
  col += green * 0.035 * haze * amount;
  col += aurora;

  // Three ridges, far to near: snow on the crests, mist pooled in the valleys between.
  vec3 light = green * act1 * amount;
  col = range(col, p, uv.y, 0.25, 0.20, 2.1, 11.0, srgb(vec3(0.060, 0.085, 0.125)), 0.55, light * 0.10, 0.6);
  col = range(col, p, uv.y, 0.14, 0.19, 1.5, 3.0, srgb(vec3(0.030, 0.042, 0.068)), 0.8, light * 0.07, 0.8);
  col = range(col, p, uv.y, 0.02, 0.15, 1.05, 23.0, srgb(vec3(0.012, 0.016, 0.028)), 1.0, light * 0.05, 1.0);

  col = 1.0 - exp(-col * 1.15);
  col = sqrt(col) * (0.92 + 0.08 * col);
  col += (hash(ivec2(gl_FragCoord.xy)) - 0.5) / 255.0;
  outColor = vec4(col, 1.0);
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
    uniforms = {
      res: gl.getUniformLocation(program, "res"),
      time: gl.getUniformLocation(program, "time"),
      mood: gl.getUniformLocation(program, "mood"),
    };
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
      const flare = Math.max(
        swell(time - mergeAt, 1400, 2600, 4500),
        0.3 * swell(time - doneAt, 900, 400, 2200),
      );
      gl.viewport(0, 0, view.canvas.width, view.canvas.height);
      gl.uniform2f(uniforms.res, view.canvas.width, view.canvas.height);
      gl.uniform1f(uniforms.time, still ? STILL : flow);
      if (still) gl.uniform4f(uniforms.mood, 0, 0, 0, 0);
      else
        gl.uniform4f(
          uniforms.mood,
          work,
          swell(time - waitAt, 1500, 3500, 3000),
          swell(time - failAt, 900, 2200, 3200),
          flare,
        );
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
