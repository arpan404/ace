/* global ace */
// Abyss: deep water under a rippling surface. Light shafts sway down from above, caustics ripple
// across the surface and the seabed, particles drift at three depths, and now and then a
// glowing jellyfish glides past. One fragment shader pass at reduced resolution.
//   working: the water moves a little quicker; shafts sway and particles drift faster.
//   waiting: sunlight breaks through warmer and brighter for a few seconds.
//   failed: the shafts fade and the water darkens, then returns.
//   pr-merged: a wave of blue-green light runs through the plankton; done is a small glow.

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
  const STILL = 140;
  /** How much quicker the scene moves while agents work. */
  const SPEEDUP = 0.6;

  const VERTEX = `#version 300 es
in vec2 corner;
void main() { gl_Position = vec4(corner, 0.0, 1.0); }`;

  const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 res;
uniform float time;
uniform vec4 mood; // working, waiting, failed, flare: each 0..1
uniform vec4 creature; // centre x, y; size; visibility
uniform float heading; // the creature's direction of travel
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

// Bright threads where the surface focuses light: two drifting ridged layers multiplied.
float caustic(vec2 p, float t) {
  vec2 w = p + 0.45 * vec2(noise(p * 0.9 + vec2(0.0, t * 0.15)), noise(p * 0.9 + vec2(5.2, -t * 0.13)));
  float a = 1.0 - abs(noise(w * 1.6 + vec2(t * 0.08, 0.0))) * 3.2;
  float b = 1.0 - abs(noise(w * 2.3 - vec2(0.0, t * 0.07) + 9.0)) * 3.2;
  return pow(clamp(a, 0.0, 1.0), 5.0) + pow(clamp(b, 0.0, 1.0), 5.0) * 0.7;
}

// Drifting particles at three depths; the nearest are large and out of focus.
vec3 snow(vec2 p, float t, float wave) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float cells = 7.0 + fi * 6.0;
    vec2 drift = vec2(t * (0.006 - fi * 0.0015), t * (0.012 - fi * 0.003));
    vec2 q = (p + drift) * cells;
    ivec2 c = ivec2(floor(q)) + ivec2(i * 389, i * 157);
    vec2 f = fract(q);
    vec2 r = hash2(c);
    vec2 at = 0.25 + 0.5 * r + 0.12 * vec2(sin(t * 0.21 + r.x * 30.0), cos(t * 0.17 + r.y * 30.0));
    float pick = hash(c + ivec2(13, 5));
    float show = smoothstep(0.45, 1.0, pick);
    float px = res.y / cells;
    float size = mix(3.4, 0.9, fi / 2.0) * (0.6 + 0.6 * r.x);  // radius in backing pixels
    float d = length(f - at) * px;
    float dot_ = exp(-d * d / (size * size)) * (fi == 0.0 ? 0.35 : 0.85);
    // a quarter of them are plankton that can glow blue-green
    float living = step(0.75, hash(c + ivec2(2, 99)));
    vec3 tint = mix(srgb(vec3(0.55, 0.72, 0.78)), srgb(vec3(0.30, 1.0, 0.85)), living * wave);
    sum += tint * dot_ * show * (0.16 + living * wave * 1.4);
  }
  return sum;
}

void main() {
  vec2 uv = gl_FragCoord.xy / res;
  vec2 p = (gl_FragCoord.xy - 0.5 * res) / res.y;
  float aspect = res.x / res.y;
  float t = time;
  float depth = 1.0 - uv.y; // 0 at the top of the window

  // Water: lit teal near the surface, deep blue, then near-black.
  vec3 col = mix(srgb(vec3(0.020, 0.075, 0.120)), srgb(vec3(0.004, 0.016, 0.040)), smoothstep(0.25, 1.0, depth));
  col = mix(srgb(vec3(0.07, 0.25, 0.30)), col, smoothstep(0.0, 0.42, depth));

  // Light shafts: bands that fan out and sway, strongest high up.
  float sunWarm = mood.y;
  float dim = 1.0 - 0.6 * mood.z;
  float s = (p.x + 0.25) / (1.0 + depth * 0.7) + depth * 0.16;
  // Broad, soft bands only: two slow noise octaves across the shafts, squared for gentle
  // falloff, and a slow shimmer along them rather than across, so nothing reads as stripes.
  float spread = noise(vec2(s * 4.2, t * 0.04)) + 0.45 * noise(vec2(s * 8.5 + 3.0, t * 0.06));
  float bands = smoothstep(-0.3, 0.55, spread);
  bands *= bands;
  float shimmer = 0.85 + 0.15 * noise(vec2(s * 2.0, depth * 3.0 - t * 0.2));
  float shaft = bands * shimmer * exp(-depth * 1.9);
  vec3 shaftCol = mix(srgb(vec3(0.35, 0.75, 0.80)), srgb(vec3(0.95, 0.85, 0.62)), sunWarm * 0.7);
  col += shaftCol * shaft * 0.24 * (1.0 + 0.9 * sunWarm) * dim;

  // The underside of the surface, a thin bright skin of caustics at the very top.
  float skin = exp(-depth * 16.0);
  vec2 sq = vec2(p.x * 2.2, depth * 9.0 + t * 0.02);
  col += srgb(vec3(0.45, 0.85, 0.90)) * caustic(sq, t) * skin * 0.32 * dim * (1.0 + 0.6 * sunWarm);
  col += srgb(vec3(0.10, 0.35, 0.40)) * skin * 0.5 * dim;

  // The seabed: soft dunes fading into the water, their crests catching a little light.
  float bed = 0.085 + 0.04 * noise(vec2(p.x * 1.4 + 3.0, 1.0)) + 0.015 * noise(vec2(p.x * 4.0, 7.0));
  float farBed = 0.15 + 0.045 * noise(vec2(p.x * 0.9 - 2.0, 4.0));
  float soft = 6.0 / res.y;
  float onFar = 1.0 - smoothstep(farBed - soft * 3.0, farBed + soft * 3.0, uv.y);
  col = mix(col, srgb(vec3(0.010, 0.036, 0.058)), onFar * 0.7);
  float onBed = 1.0 - smoothstep(bed - soft, bed + soft, uv.y);
  float crest = exp(-max(bed - uv.y, 0.0) * 30.0);
  float sand = caustic(vec2(p.x * 2.4, uv.y * 10.0), t * 0.8);
  vec3 bedCol = srgb(vec3(0.007, 0.022, 0.034)) + srgb(vec3(0.06, 0.20, 0.22)) * crest * (0.35 + 0.4 * sand) * dim;
  col = mix(col, bedCol, onBed);

  // pr-merged: a wave of plankton light crossing from left to right.
  float front = -0.75 * aspect + burst.x * 0.42;
  float across = (p.x - front) / 0.55;
  float wave = mood.w * exp(-across * across) + mood.w * 0.25 + mood.y * 0.15;
  col += snow(p, t, wave) * (1.0 - 0.5 * onBed);

  // The jellyfish: a pulsing bell with a glowing rim and trailing threads.
  if (creature.w > 0.0) {
    float size = creature.z;
    vec2 l = (p - creature.xy) / size;
    float tilt = heading - 1.5708;
    // into the creature's own frame: undo its tilt (GLSL matrices are column-major)
    l = mat2(cos(tilt), -sin(tilt), sin(tilt), cos(tilt)) * l;
    if (dot(l, l) < 30.0) {
      float beat = 0.5 + 0.5 * sin(t * 1.4);
      vec2 b = vec2(l.x / (1.0 - 0.08 * beat), l.y / (1.0 + 0.10 * beat));
      float bell = length(b) - 1.0;
      float rimLine = -0.06 + 0.16 * l.x * l.x;
      float inside = step(rimLine, l.y);
      float membrane = exp(-abs(bell) * 14.0) * inside;
      float fill = (1.0 - smoothstep(-0.4, 0.05, bell)) * inside;
      float canals = pow(abs(cos(atan(l.x, l.y + 0.1) * 4.0)), 24.0) * fill * smoothstep(0.0, 0.5, l.y);
      float margin = exp(-abs(l.y - rimLine) * 18.0) * step(abs(l.x), 1.05 + 0.1 * beat) * step(bell, 0.08);
      float threads = 0.0;
      for (int k = 0; k < 7; k++) {
        float fk = float(k);
        float x0 = (fk / 6.0 - 0.5) * 1.5;
        float down = rimLine - l.y; // below the bell, positive
        float along = max(down, 0.0);
        float x = x0 * (1.0 - 0.06 * along) + 0.18 * sin(along * 2.2 - t * 1.1 + fk * 1.7) * min(along, 1.5);
        float len = 3.2 + 1.2 * fract(fk * 0.618);
        threads += exp(-abs(l.x - x) * 26.0) * smoothstep(0.0, 0.15, down) * (1.0 - smoothstep(len * 0.4, len, along));
      }
      vec3 cyan = srgb(vec3(0.40, 0.95, 1.0));
      vec3 violet = srgb(vec3(0.62, 0.50, 1.0));
      float crown = (1.0 - smoothstep(0.0, 0.9, length(l - vec2(0.0, 0.35)))) * inside;
      vec3 glow = cyan * (membrane * 0.5 + margin * 0.55 + canals * 0.12 + crown * 0.18) + violet * (fill * 0.14 + threads * 0.2);
      glow *= 0.75 + 0.35 * beat;
      float halo = exp(-length(l * vec2(1.0, 0.7)) * 1.1) * 0.06;
      col += (glow + cyan * halo) * creature.w;
    }
  }

  // a soft vignette
  col *= 1.0 - 0.3 * smoothstep(0.5, 1.2, length(p * vec2(0.8, 1.0)));
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
  let seed = 11;
  let nextPass = 140 + 12; // the first jellyfish comes 12 s after the scene starts
  // One jellyfish at a time: where it starts, where it heads, when it started; -1 when none.
  const pass = { x: 0, y: 0, heading: 0, size: 0, start: -1 };

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw new Error(`abyss shader: ${gl.getShaderInfoLog(shader)}`);
    return shader;
  }

  function build() {
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.bindAttribLocation(program, 0, "corner");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(`abyss program: ${gl.getProgramInfoLog(program)}`);
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    uniforms = {};
    for (const name of ["res", "time", "mood", "creature", "heading", "burst"])
      uniforms[name] = gl.getUniformLocation(program, name);
  }

  function fit(view) {
    let scale = Math.min(view.pixelRatio, Math.max(MIN_SCALE, view.pixelRatio * DETAIL));
    const pixels = view.width * view.height * scale * scale;
    if (pixels > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / pixels);
    view.canvas.width = Math.max(1, Math.round(view.width * scale));
    view.canvas.height = Math.max(1, Math.round(view.height * scale));
  }

  /** A repeatable 0..1 sequence, so each pass differs but a reload looks the same. */
  function random() {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  }

  const PASS_SECONDS = 46;
  const PASS_SPEED = 0.034;

  /** The jellyfish now: x, y, size, visibility and heading. One drifts by every minute or two. */
  function creatureAt(t, aspect) {
    if (pass.start < 0 && t >= nextPass) {
      const fromLeft = random() < 0.5;
      pass.start = t;
      pass.size = 0.05 + random() * 0.03;
      // it rises from below the frame, bell first, drifting a little to one side
      pass.x = (fromLeft ? -1 : 1) * (0.2 + random() * 0.25) * aspect;
      pass.y = -0.66;
      pass.heading = fromLeft ? 1.0 + random() * 0.3 : Math.PI - 1.0 - random() * 0.3;
    }
    if (pass.start < 0) return [0, 0, 0, 0, 0];
    const age = t - pass.start;
    if (age > PASS_SECONDS) {
      pass.start = -1;
      nextPass = t + 45 + random() * 45;
      return [0, 0, 0, 0, 0];
    }
    // it swims in slow strokes: a little faster on each beat of the bell
    const travelled = age * PASS_SPEED + Math.sin(t * 1.4) * 0.006;
    const seen = ease(Math.min(age / 5, 1, (PASS_SECONDS - age) / 5));
    return [
      pass.x + Math.cos(pass.heading) * travelled,
      pass.y + Math.sin(pass.heading) * travelled,
      pass.size,
      seen,
      pass.heading,
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
      if (!gl) throw new Error("abyss needs WebGL 2");
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
      const waiting = still ? 0 : swell(time - waitAt, 1800, 3500, 3500);
      const failed = still ? 0 : swell(time - failAt, 900, 2200, 3200);
      const flare = still
        ? 0
        : Math.max(
            swell(time - mergeAt, 1400, 2600, 4500),
            0.3 * swell(time - doneAt, 900, 400, 2200),
          );
      // The still frame keeps the jellyfish in view, rising on the right.
      const aspect = view.width / Math.max(view.height, 1);
      const [jx, jy, size, seen, heading] = still
        ? [0.34 * aspect, -0.05, 0.07, 1, 1.9]
        : creatureAt(t, aspect);
      gl.uniform4f(uniforms.creature, jx, jy, size, seen);
      gl.uniform1f(uniforms.heading, heading);
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
