/* global ace */
// Nebula: deep-space clouds churning slowly (domain-warped noise), dust lanes, three depths of
// stars drifting at different speeds, and a comet every minute or so. One fragment shader pass.
//   working: the clouds churn a little quicker and brighter.
//   waiting: the core warms and breathes once.
//   failed: the gas cools toward grey and dims, then returns.
//   pr-merged: a soft bloom from the core with a faint ring moving outward; done is a small glow.

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
  const STILL = 312;
  /** How much quicker the scene moves while agents work. */
  const SPEEDUP = 0.8;

  const VERTEX = `#version 300 es
in vec2 corner;
void main() { gl_Position = vec4(corner, 0.0, 1.0); }`;

  const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 res;
uniform float time;
uniform vec4 mood; // working, waiting, failed, flare: each 0..1
uniform vec4 comet; // head x, y; heading; brightness
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

const mat2 turn = mat2(0.8, -0.6, 0.6, 0.8);
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * noise(p);
    p = turn * p * 2.03 + vec2(17.1, 3.7);
    a *= 0.5;
  }
  return s;
}
float fbm3(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) {
    s += a * noise(p);
    p = turn * p * 2.03 + vec2(17.1, 3.7);
    a *= 0.5;
  }
  return s;
}

// Three depths of stars; nearer ones are larger and drift further with the camera.
vec3 stars(vec2 p, vec2 cam, float t, float veil) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float cells = 18.0 + fi * 16.0;
    vec2 q = (p + cam * (1.6 - fi * 0.55)) * cells;
    ivec2 c = ivec2(floor(q)) + ivec2(i * 541, i * 223);
    vec2 f = fract(q);
    vec2 at = 0.2 + hash2(c) * 0.6;
    float pick = hash(c + ivec2(11, 7));
    float magnitude = pow(smoothstep(0.9 + fi * 0.025, 1.0, pick), 1.8) * (1.0 - fi * 0.3);
    float d = length(f - at) * res.y / cells;
    float twinkle = 0.85 + 0.15 * sin(t * (0.3 + 0.7 * hash(c + ivec2(3, 1))) + pick * 50.0);
    float core = exp(-d * d * (1.1 - fi * 0.25));
    // the brightest few wear a faint soft cross
    vec2 g = (f - at) * res.y / cells;
    float cross = (exp(-abs(g.x) * 1.4) * exp(-abs(g.y) * 0.12) + exp(-abs(g.y) * 1.4) * exp(-abs(g.x) * 0.12));
    float halo = exp(-d * 0.35) * 0.06 + cross * 0.05;
    halo *= step(0.996, pick) * step(float(i), 0.5);
    vec3 tint = mix(vec3(0.70, 0.80, 1.0), vec3(1.0, 0.86, 0.72), hash(c + ivec2(9, 2)));
    sum += tint * magnitude * twinkle * (core + halo) * mix(1.0, veil, 0.7 - fi * 0.2);
  }
  return sum * 1.5;
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * res) / res.y;
  float t = time;
  float flare = mood.w;
  vec2 cam = vec2(t * 0.0035, t * 0.0012);

  // Domain-warped clouds: two gentle warps feed a third look-up, all drifting slowly.
  vec2 q = p * 0.95 + cam;
  vec2 w1 = vec2(fbm3(q + vec2(0.0, t * 0.006)), fbm3(q + vec2(5.2, 1.3) - t * 0.005));
  vec2 w2 = vec2(fbm(q + 1.8 * w1 + vec2(1.7, 9.2) + t * 0.0035), fbm(q + 1.8 * w1 + vec2(8.3, 2.8) - t * 0.003));
  float f = fbm(q + 2.1 * w2);

  // Where the light gathers: a core off to the upper right, a fainter arm low on the left.
  vec2 core = vec2(0.42, 0.14);
  float toCore = length((p - core) * vec2(0.75, 1.0));
  float gather = exp(-toCore * 1.9) + 0.45 * exp(-length((p - vec2(-0.6, -0.25)) * vec2(0.6, 1.0)) * 2.4);

  float dens = smoothstep(-0.12, 0.55, f + 0.3 * gather);
  float glow = dens * dens * (0.06 + 1.35 * gather);

  // Colour drifts over large regions, not per wisp: teal and blue into rose, warm where dense.
  float hue = smoothstep(-0.28, 0.28, fbm3(q * 0.45 + vec2(7.0, 3.0) + w1 * 0.4));
  vec3 teal = srgb(vec3(0.16, 0.50, 0.64));
  vec3 rose = srgb(vec3(0.70, 0.22, 0.55));
  vec3 gas = mix(teal, rose, hue);
  gas = mix(gas, srgb(vec3(1.0, 0.80, 0.92)), smoothstep(0.45, 1.1, glow) * 0.5);

  // waiting: the core warms and breathes once; failed: the gas cools toward grey and dims
  float warmth = mood.y * exp(-toCore * 1.5);
  gas = mix(gas, gas * vec3(1.35, 0.95, 0.70), warmth * 0.8);
  float grey = dot(gas, vec3(0.3, 0.5, 0.2));
  gas = mix(gas, vec3(grey) * vec3(0.75, 0.85, 1.05), mood.z * 0.65);
  float light = glow * (1.0 + 0.3 * mood.x + 0.4 * warmth) * (1.0 - 0.4 * mood.z);

  // Dust lanes: dark threads across the brighter gas.
  float dust = smoothstep(0.0, 0.3, fbm3(q * 1.7 + w2 * 1.2 + vec2(40.0, 12.0)));
  float veil = 1.0 - 0.75 * dust * smoothstep(0.05, 0.5, dens);

  vec3 col = srgb(vec3(0.010, 0.010, 0.028)) + gas * light * veil * 0.9;
  // light scattered around the core, under the gas
  col += srgb(vec3(0.55, 0.32, 0.50)) * exp(-toCore * 2.6) * 0.10 * (1.0 + warmth) * (1.0 - 0.4 * mood.z);
  col += stars(p, cam, t, veil);

  // pr-merged: a soft bloom from the core with a faint ring moving outward.
  float bloom = exp(-toCore * 7.0) * 0.6;
  float ringAt = (toCore - burst.x * 0.16) / 0.07;
  float ring = exp(-ringAt * ringAt) * (1.0 - smoothstep(1.5, 5.0, burst.x)) * exp(-toCore * 3.0);
  col += (srgb(vec3(1.0, 0.78, 0.90)) * bloom + srgb(vec3(0.75, 0.70, 1.0)) * ring * 0.12) * flare;

  // A comet now and then: a bright head and a tail that widens and fades behind it.
  if (comet.w > 0.0) {
    vec2 dir = vec2(cos(comet.z), sin(comet.z));
    vec2 rel = p - comet.xy;
    float behind = -dot(rel, dir);
    float side = dot(rel, vec2(-dir.y, dir.x));
    float width = 0.0025 + max(behind, 0.0) * 0.045;
    float tail = step(0.0, behind) * exp(-behind * 7.5) * exp(-side * side / (width * width));
    float head = exp(-dot(rel, rel) * 26000.0) + exp(-length(rel) * 60.0) * 0.25;
    col += srgb(vec3(0.75, 0.90, 1.0)) * (tail * 0.32 + head * 0.9) * comet.w;
  }

  // a quiet vignette keeps the edges deep
  col *= 1.0 - 0.35 * smoothstep(0.35, 1.05, length(p * vec2(0.85, 1.1)));
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
  let cometSeed = 7;
  let nextComet = 312 + 20; // the first comet, 20 s after the scene starts (STILL is 312)
  // Each comet: where it starts, its heading, when it started (scene seconds); -1 when none.
  const comet = { x: 0, y: 0, heading: 0, start: -1 };

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw new Error(`nebula shader: ${gl.getShaderInfoLog(shader)}`);
    return shader;
  }

  function build() {
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.bindAttribLocation(program, 0, "corner");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(`nebula program: ${gl.getProgramInfoLog(program)}`);
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    uniforms = {};
    for (const name of ["res", "time", "mood", "comet", "burst"])
      uniforms[name] = gl.getUniformLocation(program, name);
  }

  function fit(view) {
    let scale = Math.min(view.pixelRatio, Math.max(0.75, view.pixelRatio * DETAIL));
    const pixels = view.width * view.height * scale * scale;
    if (pixels > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / pixels);
    view.canvas.width = Math.max(1, Math.round(view.width * scale));
    view.canvas.height = Math.max(1, Math.round(view.height * scale));
  }

  /** A repeatable 0..1 sequence, so comets differ from each other but a reload looks the same. */
  function random() {
    cometSeed = (cometSeed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return cometSeed / 2_147_483_648;
  }

  const COMET_SECONDS = 7;
  const COMET_SPEED = 0.085;

  /** The comet now: head x, y, heading and brightness. One crosses every 40 to 80 seconds. */
  function cometAt(t, aspect) {
    if (comet.start < 0 && t >= nextComet) {
      const fromLeft = random() < 0.5;
      comet.start = t;
      comet.x = (fromLeft ? -0.3 : 0.3) * aspect + (random() - 0.5) * 0.3;
      comet.y = 0.18 + random() * 0.24;
      comet.heading = fromLeft ? -0.35 - random() * 0.3 : Math.PI + 0.35 + random() * 0.3;
    }
    if (comet.start < 0) return [0, 0, 0, 0];
    const age = t - comet.start;
    if (age > COMET_SECONDS) {
      comet.start = -1;
      nextComet = t + 40 + random() * 40;
      return [0, 0, 0, 0];
    }
    const travelled = age * COMET_SPEED;
    const life = ease(Math.min(age / 1.2, 1, (COMET_SECONDS - age) / 1.6));
    return [
      comet.x + Math.cos(comet.heading) * travelled,
      comet.y + Math.sin(comet.heading) * travelled,
      comet.heading,
      life,
    ];
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
      if (!gl) throw new Error("nebula needs WebGL 2");
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
      // The still frame keeps one comet in flight, high on the left.
      const aspect = view.width / Math.max(view.height, 1);
      const [cx, cy, heading, bright] = still
        ? [-0.36 * aspect, 0.3, -0.55, 0.8]
        : cometAt(t, aspect);
      gl.uniform4f(uniforms.comet, cx, cy, heading, bright);
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
