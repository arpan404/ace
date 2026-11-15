/* global ace */
// Sakura Dusk: a garden at dusk under blossoming branches. A string of paper lanterns sways and
// flickers softly; petals drift on gusts of wind at three depths, the nearest large and out of
// focus. One fragment shader pass at reduced resolution.
//   working: the wind picks up and more petals fall.
//   waiting: the lanterns glow warmer and brighter for a few seconds.
//   failed: the lanterns dim and the dusk cools, then return.
//   pr-merged: a gust lifts a flurry of petals and the lanterns bloom; done is a small glow.

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
  const STILL = 88;
  /** How much quicker the scene moves while agents work. */
  const SPEEDUP = 0.3;

  const VERTEX = `#version 300 es
in vec2 corner;
void main() { gl_Position = vec4(corner, 0.0, 1.0); }`;

  const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 res;
uniform float time;
uniform vec4 mood; // working, waiting, failed, flare: each 0..1
uniform vec2 wind; // how far the wind has carried the petals
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

const mat2 turn = mat2(0.8, -0.6, 0.6, 0.8);
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * noise(p);
    p = turn * p * 2.05 + vec2(11.3, 4.1);
    a *= 0.5;
  }
  return s;
}

// Distance to a branch y = f(x) running in from a corner, tapering as it goes.
float branch(vec2 p, float y0, float slope, float bend, float freq, float x0, float x1, float w0) {
  float x = clamp(p.x, x0, x1);
  float y = y0 + slope * (x - x0) + bend * sin((x - x0) * freq);
  float dy = slope + bend * freq * cos((x - x0) * freq);
  float d = abs(p.y - y) / sqrt(1.0 + dy * dy) + max(max(x0 - p.x, p.x - x1), 0.0);
  float along = clamp((p.x - x0) / (x1 - x0), 0.0, 1.0);
  float w = w0 * (1.0 - 0.8 * abs(along));
  return d - w;
}

// Blossoms packed into a cluster: soft round flowers of varied pinks, shadow between them.
float flowers(vec2 p, float cells, float seed) {
  vec2 q = p * cells;
  ivec2 c = ivec2(floor(q)) + ivec2(int(seed) * 37, 0);
  vec2 at = 0.28 + 0.44 * hash2(c);
  float r = 0.30 + 0.16 * hash(c + ivec2(2, 2));
  float d = length(fract(q) - at);
  return (1.0 - smoothstep(r * 0.45, r, d)) * (0.55 + 0.45 * hash(c + ivec2(6, 1)));
}

// Petals at one depth. size: radius in screen-heights; soft: edge blur (0 sharp .. 1 soft).
vec4 petals(vec2 p, float cells, float seed, float size, float soft, float density, float t, vec2 drift) {
  vec2 q = (p + drift) * cells;
  ivec2 c = ivec2(floor(q)) + ivec2(int(seed) * 211, int(seed) * 59);
  vec2 f = fract(q);
  float h = hash(c);
  if (h > density) return vec4(0.0);
  vec2 r = hash2(c + ivec2(5, 1));
  vec2 at = 0.3 + 0.4 * r + vec2(0.12 * sin(t * 0.55 + r.x * 20.0), 0.10 * sin(t * 0.42 + r.y * 17.0));
  vec2 l = (f - at) / (size * cells);
  float spin = t * (0.25 + 0.45 * r.y) * (r.x < 0.5 ? 1.0 : -1.0) + h * 40.0;
  l = mat2(cos(spin), sin(spin), -sin(spin), cos(spin)) * l;
  float tumble = 0.3 + 0.7 * abs(cos(t * (0.35 + 0.5 * r.x) + r.y * 9.0));
  l.y /= tumble;
  float body = length(vec2(l.x, l.y * 1.7)) - 1.0;
  float notch = 0.32 - length(l - vec2(1.05, 0.0));
  float d = max(body, notch);
  float edge = mix(0.12, 0.9, soft);
  float m = 1.0 - smoothstep(-edge, edge * 0.4, d);
  vec3 tint = mix(srgb(vec3(1.0, 0.86, 0.90)), srgb(vec3(0.96, 0.58, 0.72)), smoothstep(-0.6, 1.0, l.x));
  tint *= 0.75 + 0.35 * tumble; // the face turned toward the light is brighter
  return vec4(tint, m);
}

void main() {
  vec2 uv = gl_FragCoord.xy / res;
  float aspect = res.x / res.y;
  vec2 p = vec2(gl_FragCoord.x / res.y, uv.y); // x in screen-heights from the left
  float t = time;
  float lampUp = 1.0 + 0.45 * mood.y + 0.6 * mood.w;
  float cool = mood.z;
  float lamp = lampUp * (1.0 - 0.5 * cool);

  // Dusk: indigo overhead, mauve, a warm peach glow low down.
  vec3 col = mix(srgb(vec3(0.95, 0.60, 0.50)), srgb(vec3(0.46, 0.27, 0.44)), smoothstep(0.22, 0.48, uv.y));
  col = mix(col, srgb(vec3(0.13, 0.10, 0.26)), smoothstep(0.42, 0.95, uv.y));
  col *= 0.55;

  // Far hills, soft with distance, mist pooled at their feet.
  float hillFar = 0.30 + 0.05 * fbm(vec2(p.x * 1.1, 2.0));
  col = mix(col, mix(srgb(vec3(0.30, 0.22, 0.40)), col, 0.45) * 0.62, 1.0 - smoothstep(hillFar - 0.012, hillFar + 0.012, uv.y));
  float hillNear = 0.22 + 0.06 * fbm(vec2(p.x * 1.7 + 5.0, 3.0));
  col = mix(col, srgb(vec3(0.17, 0.11, 0.22)) * 0.6, 1.0 - smoothstep(hillNear - 0.008, hillNear + 0.008, uv.y));
  col += srgb(vec3(0.7, 0.45, 0.55)) * 0.05 * exp(-abs(uv.y - 0.2) * 14.0);

  // The garden: dark shrubs, two stone lanterns glowing low among them.
  float shrubs = 0.115 + 0.04 * fbm(vec2(p.x * 2.6, 6.0)) + 0.025 * abs(noise(vec2(p.x * 9.0, 1.0)));
  vec3 warm = srgb(vec3(1.0, 0.62, 0.30));
  vec2 stoneA = vec2(0.16 * aspect, 0.10);
  vec2 stoneB = vec2(0.86 * aspect, 0.085);
  float poolA = exp(-length((p - stoneA) * vec2(1.0, 2.2)) * 15.0);
  float poolB = exp(-length((p - stoneB) * vec2(1.0, 2.2)) * 15.0);
  float pools = poolA + poolB;
  vec3 garden = srgb(vec3(0.030, 0.020, 0.042)) + warm * pools * 0.12 * lamp;
  float onGarden = 1.0 - smoothstep(shrubs - 0.004, shrubs + 0.004, uv.y);
  garden += warm * 0.12 * lamp * pools * exp(-max(shrubs - uv.y, 0.0) * 60.0); // light on the shrub tops
  col = mix(col, garden, onGarden);
  float flameA = exp(-length((p - stoneA) * vec2(1.0, 0.8)) * 220.0) + exp(-length(p - stoneA) * 40.0) * 0.12;
  float flameB = exp(-length((p - stoneB) * vec2(1.0, 0.8)) * 220.0) + exp(-length(p - stoneB) * 40.0) * 0.12;
  col += warm * (flameA + flameB) * 0.9 * lamp;
  col += warm * pools * 0.05 * lamp;

  // Branches reaching in from the top corners, heavy with blossom.
  float left = branch(p, 0.98, -0.42, 0.04, 6.0, -0.05, 0.62, 0.012);
  left = min(left, branch(p, 0.80, -0.08, 0.03, 9.0, -0.05, 0.40, 0.008));
  float right = branch(vec2(aspect - p.x, p.y), 0.99, -0.30, 0.05, 5.0, -0.05, 0.70, 0.013);
  right = min(right, branch(vec2(aspect - p.x, p.y), 0.86, -0.12, 0.03, 8.0, -0.05, 0.36, 0.008));
  float wood = min(left, right);
  float sway = 0.004 * sin(t * 0.5) + 0.002 * sin(t * 1.1);
  vec2 bp = p + vec2(sway * smoothstep(0.6, 1.0, uv.y), 0.0);
  float puff = fbm(bp * 6.0) + 0.4 * fbm(bp * 15.0 - 3.0);
  float fl = max(flowers(bp, 36.0, 1.0), flowers(bp + 0.37, 54.0, 2.0) * 0.8);
  float region = 0.075 - wood * 0.85 + puff * 0.08;
  float bloom = smoothstep(0.0, 0.03, region + (fl - 0.5) * 0.04);
  vec3 shade = srgb(vec3(0.42, 0.21, 0.33));
  vec3 petal = mix(srgb(vec3(0.86, 0.52, 0.66)), srgb(vec3(0.98, 0.80, 0.86)), smoothstep(0.6, 1.0, fl));
  vec3 blossom = mix(shade, petal, fl * smoothstep(-0.02, 0.25, puff + 0.1));
  blossom += warm * 0.12 * lamp * (1.0 - smoothstep(0.6, 0.9, uv.y)) * fl; // lit from below by the lanterns
  blossom *= 0.58;
  col = mix(col, blossom, bloom);
  float woodMask = 1.0 - smoothstep(-0.0015, 0.0015, wood);
  col = mix(col, srgb(vec3(0.05, 0.03, 0.045)), woodMask * (1.0 - bloom * 0.75 * fl));

  // A string of paper lanterns, sagging across the garden.
  float x0 = 0.04 * aspect, x1 = 0.96 * aspect;
  float mid = 0.5 * (x0 + x1), half_ = 0.5 * (x1 - x0);
  float sx = (p.x - mid) / half_;
  float stringY = 0.70 + 0.11 * (sx * sx - 1.0);
  col = mix(col, srgb(vec3(0.08, 0.05, 0.07)), (1.0 - smoothstep(0.0012, 0.0028, abs(uv.y - stringY))) * step(abs(sx), 1.0) * 0.85);
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    float lx = mix(x0, x1, (fi + 0.5) / 7.0);
    float ls = (lx - mid) / half_;
    float hangY = 0.70 + 0.11 * (ls * ls - 1.0) - 0.055;
    float sway = 0.05 * sin(t * 0.55 + fi * 1.3) + 0.02 * sin(t * 0.9 + fi * 2.1);
    vec2 pivot = vec2(lx, hangY + 0.055);
    vec2 rel = p - pivot;
    rel = mat2(cos(sway), -sin(sway), sin(sway), cos(sway)) * rel + vec2(0.0, 0.055);
    vec2 e = rel / vec2(0.026, 0.034);
    float body = length(e);
    float flicker = 0.9 + 0.1 * noise(vec2(t * 0.7, fi * 3.7));
    float lit = flicker * lamp;
    vec3 paper = mix(srgb(vec3(1.0, 0.78, 0.45)), srgb(vec3(0.95, 0.38, 0.25)), smoothstep(0.0, 1.0, body));
    float ribs = 0.86 + 0.14 * smoothstep(0.2, 0.9, abs(sin(e.y * 6.0)));
    float inside = 1.0 - smoothstep(0.96, 1.04, body);
    float cap = (1.0 - smoothstep(0.003, 0.006, abs(abs(rel.y) - 0.034))) * step(abs(rel.x), 0.012);
    float cord = (1.0 - smoothstep(0.0008, 0.0022, abs(rel.x))) * step(0.0, rel.y - 0.03) * step(rel.y, 0.058);
    col = mix(col, paper * ribs * 1.1 * lit, inside);
    col = mix(col, srgb(vec3(0.10, 0.05, 0.06)), max(cap, cord) * 0.9);
    col += srgb(vec3(1.0, 0.55, 0.28)) * exp(-body * 1.5) * 0.10 * lit * (1.0 - inside);
  }

  // Petals on the wind: far and small, mid and crisp, near and large and out of focus.
  vec4 far = petals(p, 12.0, 1.0, 0.0055, 0.1, 0.16 + 0.2 * mood.x + 0.3 * mood.w, t, wind * 0.45);
  vec4 midP = petals(p, 7.0, 2.0, 0.0105, 0.05, 0.16 + 0.2 * mood.x + 0.3 * mood.w, t, wind * 0.8);
  vec4 near = petals(p, 2.6, 3.0, 0.026, 0.55, 0.16 + 0.15 * mood.x + 0.2 * mood.w, t, wind * 1.6);
  col = mix(col, far.rgb * 0.42 * (0.7 + 0.3 * lamp), far.a * 0.6);
  col = mix(col, midP.rgb * 0.62 * (0.7 + 0.3 * lamp), midP.a * 0.9);
  col = mix(col, near.rgb * 0.55, near.a * 0.35);

  col = mix(col, vec3(dot(col, vec3(0.3, 0.5, 0.2))) * vec3(0.75, 0.82, 1.05), cool * 0.5);
  col *= 1.0 - 0.3 * smoothstep(0.55, 1.25, length((uv - 0.5) * vec2(aspect, 1.0)));
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
  // How far the wind has carried the petals: x with the wind, y as they fall.
  const carried = [-4, 9];

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw new Error(`sakura-dusk shader: ${gl.getShaderInfoLog(shader)}`);
    return shader;
  }

  function build() {
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.bindAttribLocation(program, 0, "corner");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(`sakura-dusk program: ${gl.getProgramInfoLog(program)}`);
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    uniforms = {};
    for (const name of ["res", "time", "mood", "wind"])
      uniforms[name] = gl.getUniformLocation(program, name);
  }

  function fit(view) {
    let scale = Math.min(view.pixelRatio, Math.max(0.75, view.pixelRatio * DETAIL));
    const pixels = view.width * view.height * scale * scale;
    if (pixels > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / pixels);
    view.canvas.width = Math.max(1, Math.round(view.width * scale));
    view.canvas.height = Math.max(1, Math.round(view.height * scale));
  }

  /** The wind's speed now: a light breeze with slow gusts, stronger while agents work. */
  function breeze(t, working, gust) {
    const surge = 0.5 + 0.5 * Math.sin(t * 0.07) * Math.sin(t * 0.031 + 1.3);
    return 0.018 + 0.03 * surge * surge + 0.02 * working + 0.12 * gust;
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
      if (!gl) throw new Error("sakura-dusk needs WebGL 2");
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
      const waiting = still ? 0 : swell(time - waitAt, 1500, 3500, 3500);
      const failed = still ? 0 : swell(time - failAt, 900, 2200, 3200);
      const flare = still
        ? 0
        : Math.max(
            swell(time - mergeAt, 1400, 2600, 4500),
            0.3 * swell(time - doneAt, 900, 400, 2200),
          );
      if (!still) {
        const seconds = dt / 1000;
        const gust = swell(time - mergeAt, 700, 1500, 3500);
        carried[0] -= breeze(t, working, gust) * seconds;
        carried[1] += (0.012 + 0.006 * working - 0.02 * gust) * seconds;
      }
      gl.uniform2f(uniforms.wind, carried[0], carried[1]);

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
