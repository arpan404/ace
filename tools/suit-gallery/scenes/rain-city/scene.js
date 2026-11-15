/* global ace */
// Rain City: rain on a window pane at night, over a blurred neon city. Small drops form on the
// misted glass; larger ones gather, run in slow stick-and-slide paths, leave a clear trail of
// droplets and swallow the drops in their way. Each drop is a lens: it shows the city sharp and
// upside down. One fragment shader pass at reduced resolution.
//   working: heavier rain, more drops forming and a second set of runners.
//   waiting: the amber lights warm and brighten for a few seconds.
//   failed: the city dims and greys under the rain, then returns.
//   pr-merged: the neon swells and the sky over the city glows; done is a small glow.

const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
/** 0 → 1 over `rise` ms, held `hold` ms, back to 0 over `fall` ms. `age` is ms since. */
const swell = (age, rise, hold, fall) =>
  age < 0 ? 0 : age < rise + hold ? ease(age / rise) : 1 - ease((age - rise - hold) / fall);

(() => {
  "use strict";

  /** Backing pixels per device pixel; the browser scales the canvas up smoothly. */
  const DETAIL = 0.5;
  /** Never fewer backing pixels per CSS pixel than this, even on a 1x display. */
  const MIN_SCALE = 0.75;
  /** At most this many backing pixels, whatever the window. */
  const MAX_PIXELS = 1_400_000;
  /** Scene seconds of the still frame drawn under Reduce motion. */
  const STILL = 90;
  /** How much quicker the scene moves while agents work. */
  const SPEEDUP = 0.35;

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

const vec3 MAGENTA = vec3(1.0, 0.22, 0.62);
const vec3 CYAN = vec3(0.18, 0.80, 1.0);
const vec3 AMBER = vec3(1.0, 0.62, 0.22);
const vec3 PALE = vec3(0.80, 0.85, 1.0);

vec3 lightColour(float h) {
  vec3 c = h < 0.3 ? MAGENTA : h < 0.55 ? CYAN : h < 0.85 ? AMBER : PALE;
  return srgb(c);
}

// One layer of out-of-focus lights. focus 0..1: 1 is sharp points, 0 is wide soft discs.
vec3 bokeh(vec2 uv, float cells, float seed, float focus, float t, float low, float high) {
  vec3 sum = vec3(0.0);
  vec2 q = uv * cells;
  ivec2 base = ivec2(floor(q));
  for (int j = -1; j <= 1; j++)
  for (int i = -1; i <= 1; i++) {
    ivec2 c = base + ivec2(i, j);
    ivec2 k = c + ivec2(int(seed) * 97, int(seed) * 31);
    vec2 at = vec2(c) + 0.15 + 0.7 * hash2(k);
    float h = hash(k + ivec2(7, 3));
    float y = at.y / cells;
    float present = step(0.45, h) * (1.0 - smoothstep(low * 0.6, low, y)) * smoothstep(0.0, 0.08, y);
    if (present <= 0.0) continue;
    vec3 tint = lightColour(hash(k + ivec2(1, 9)));
    tint *= mix(vec3(1.0), vec3(1.4, 1.15, 0.8), mood.y * step(0.55, hash(k + ivec2(1, 9))) * step(hash(k + ivec2(1, 9)), 0.85));
    float r = mix(0.46, 0.09, focus) * (0.45 + 0.6 * hash(k + ivec2(4, 4)));
    float d = length(q - at) / r;
    float disc = 1.0 - smoothstep(mix(0.72, 0.2, focus), 1.0, d);
    float rim = smoothstep(0.55, 0.95, d) * disc * (1.0 - focus) * 0.35;
    float breathe = 0.85 + 0.15 * sin(t * (0.15 + 0.3 * h) + h * 40.0);
    float energy = mix(0.16, 0.9, focus);
    sum += tint * (disc + rim) * energy * breathe * (0.35 + 0.65 * hash(k + ivec2(8, 1)));
  }
  return sum;
}

// Car lights in two lanes, drifting in opposite directions.
vec3 traffic(vec2 uv, float focus, float t) {
  vec3 sum = vec3(0.0);
  for (int lane = 0; lane < 2; lane++) {
    float fl = float(lane);
    float y = 0.205 - fl * 0.035;
    float dir = fl < 0.5 ? 1.0 : -1.0;
    float x = uv.x * 5.0 - dir * t * 0.12;
    float cell = floor(x);
    float f = fract(x);
    ivec2 k = ivec2(int(cell), lane + 50);
    float on = step(0.55, hash(k)) * (0.5 + 0.5 * hash(k + ivec2(2, 2)));
    float at = 0.2 + 0.6 * hash(k + ivec2(0, 3));
    float r = mix(0.03, 0.006, focus);
    vec2 d = vec2((f - at) / 5.0, uv.y - y);
    float pair = 1.0 - smoothstep(r * 0.5, r, length(d - vec2(0.006, 0.0)));
    pair = max(pair, 1.0 - smoothstep(r * 0.5, r, length(d + vec2(0.006, 0.0))));
    vec3 tint = fl < 0.5 ? srgb(vec3(1.0, 0.25, 0.20)) : srgb(vec3(1.0, 0.92, 0.80));
    sum += tint * pair * on * mix(0.12, 0.7, focus);
  }
  return sum;
}

// The city behind the glass, at a given focus.
vec3 city(vec2 uv, float focus, float t, float aspect) {
  float glowUp = 1.0 + 0.6 * mood.w;
  vec3 col = mix(srgb(vec3(0.10, 0.06, 0.13)), srgb(vec3(0.022, 0.020, 0.045)), smoothstep(0.1, 0.95, uv.y));
  col += srgb(vec3(0.35, 0.10, 0.30)) * 0.12 * mood.w * (1.0 - smoothstep(0.3, 0.9, uv.y));

  // Towers: dark slabs, each with a soft glow of lit windows.
  float soft = mix(0.035, 0.004, focus);
  float bx = uv.x * 7.0;
  float tower = floor(bx);
  float height = 0.32 + 0.33 * hash(ivec2(int(tower), 3));
  float edgeX = smoothstep(0.0, soft * 7.0, fract(bx)) * smoothstep(1.0, 1.0 - soft * 7.0, fract(bx));
  float body = (1.0 - smoothstep(height - soft, height + soft, uv.y)) * mix(1.0, edgeX, 0.6);
  float lit = hash(ivec2(int(tower), 17));
  vec3 windowTint = srgb(lit < 0.5 ? vec3(1.0, 0.75, 0.45) : vec3(0.65, 0.80, 1.0));
  float rows = 0.6 + 0.4 * noise(vec2(tower * 3.1, uv.y * 9.0));
  col = mix(col, srgb(vec3(0.025, 0.022, 0.045)) + windowTint * rows * 0.035, body * 0.9);

  // Neon signs: two big glows that breathe slowly.
  float signA = exp(-length((uv - vec2(0.22 * aspect, 0.42)) * vec2(1.6, 2.4)) * 4.2);
  float signB = exp(-length((uv - vec2(0.78 * aspect, 0.36)) * vec2(2.0, 2.6)) * 4.2);
  col += srgb(MAGENTA) * signA * 0.45 * (0.9 + 0.1 * sin(t * 0.4)) * glowUp;
  col += srgb(CYAN) * signB * 0.38 * (0.9 + 0.1 * sin(t * 0.33 + 2.0)) * glowUp;

  col += bokeh(uv, 7.0, 1.0, focus, t, 0.62, 0.0) * 0.40 * glowUp;
  col += bokeh(uv + vec2(0.37, 0.11), 3.6, 2.0, focus, t, 0.70, 0.0) * 0.40 * glowUp;
  col += traffic(uv, focus, t);
  // waiting warms the whole city a little; failed greys and dims it
  float grey = dot(col, vec3(0.3, 0.5, 0.2));
  col = mix(col, vec3(grey) * vec3(0.85, 0.9, 1.05), mood.z * 0.6) * (1.0 - 0.4 * mood.z);
  return col;
}

// Small drops that form and fade on the glass. Returns normal.xy, coverage.
vec3 beads(vec2 uv, float cells, float seed, float t, float density) {
  vec2 q = uv * cells;
  ivec2 c = ivec2(floor(q)) + ivec2(int(seed) * 71, 0);
  vec2 f = fract(q);
  vec2 at = 0.2 + 0.6 * hash2(c);
  float h = hash(c + ivec2(3, 8));
  float life = fract(t * (0.025 + 0.02 * h) + h * 9.0);
  float grow = smoothstep(0.0, 0.25, life) * (1.0 - smoothstep(0.8, 1.0, life));
  float show = 1.0 - smoothstep(density - 0.08, density, hash(c + ivec2(9, 2)));
  float r = (0.12 + 0.16 * hash(c + ivec2(5, 5))) * grow * show;
  vec2 d = (f - at) / max(r, 1e-4);
  float m = (1.0 - smoothstep(0.8, 1.0, length(d))) * step(0.01, r);
  return vec3(d * m, m);
}

// The x of a running drop's path at height y within its cell.
float path(float y, float n) {
  return (n - 0.5) * 0.2 + 0.04 * sin(y * 8.0 + n * 20.0) + 0.02 * sin(y * 21.0 + n * 9.0);
}

// Large drops that gather, then run in slow slides. Returns normal.xy, coverage, trail.
vec4 runners(vec2 uv, float cols, float seed, float t, float present) {
  vec2 cell = vec2(1.0, 3.0) / cols;
  // Each row of cells is shifted sideways by its own amount, so drops never line up in
  // columns down the whole pane.
  vec2 q = uv / cell;
  float row = floor(q.y);
  q.x += hash(ivec2(int(row), int(seed) * 7 + 3)) * 1.7;
  float column = floor(q.x);
  ivec2 id = ivec2(int(column), int(row) + int(seed) * 1000);
  vec2 f = fract(q) - 0.5;
  float n = hash(id);
  float on = step(hash(id + ivec2(4, 4)), present);
  float phase = fract(t * (0.045 + 0.04 * n) + n * 7.3);
  float slide = phase - 0.7 * sin(phase * 6.2831853) / 6.2831853; // rests a little, then slides
  // each drop gathers at its own height, so resting drops never form a row
  float start = 0.36 - 0.6 * hash(id + ivec2(9, 31));
  float y = mix(start, -0.36, slide);
  float r = (0.25 + 0.09 * n) * cell.x;
  vec2 d = vec2((f.x - path(y, n)) * cell.x, (f.y - y) * cell.y);
  d.y *= d.y > 0.0 ? 0.8 : 1.05; // a little heavier at the bottom
  float fade = smoothstep(0.0, 0.12, phase) * (1.0 - smoothstep(0.9, 1.0, phase)) * on;
  float m = (1.0 - smoothstep(0.82, 1.0, length(d) / r)) * fade;
  vec2 normal = d / r * m;

  // Above the drop: a cleared trail, dotted with the droplets it left behind.
  float above = f.y - y;
  float trailW = abs(f.x - path(f.y, n)) * cell.x / (r * 0.7);
  float trail = (1.0 - smoothstep(0.5, 1.0, trailW)) * smoothstep(0.0, 0.03, above) * (1.0 - smoothstep(0.0, 0.85, above)) * fade;
  float k = (f.y + 0.5) * 11.0;
  float ty = (floor(k) + 0.5) / 11.0 - 0.5;
  float bead = hash(id + ivec2(int(floor(k)), 7));
  float jitter = (hash(id + ivec2(int(floor(k)), 19)) - 0.5) * 0.12;
  vec2 td = vec2((f.x - path(ty, n) - jitter) * cell.x, (f.y - ty) * cell.y);
  float tr = r * (0.14 + 0.22 * bead) * step(0.45, bead);
  float drop = (1.0 - smoothstep(0.75, 1.0, length(td) / max(tr, 1e-4))) * step(1e-4, tr) * step(0.04, ty - y) * (1.0 - smoothstep(0.1, 0.8, ty - y)) * fade;
  normal += td / max(tr, 1e-4) * drop;
  return vec4(normal, max(m, drop), trail);
}

void main() {
  vec2 uv = gl_FragCoord.xy / res.y;
  float aspect = res.x / res.y;
  float t = time;
  float heavy = mood.x;

  // two interleaved sets, half a cell apart both ways, so resting drops never band by row
  vec4 runA = runners(uv, 11.0, 1.0, t, 0.42);
  vec4 runB = runners(uv + vec2(0.5 / 11.0, 1.5 / 11.0), 11.0, 3.0, t * 0.93, 0.42);
  vec4 run = runA.z >= runB.z ? vec4(runA.xyz, max(runA.w, runB.w)) : vec4(runB.xyz, max(runA.w, runB.w));
  vec4 run2 = runners(uv + vec2(0.043, 0.0), 15.0, 2.0, t * 1.1, heavy * 0.5);
  float trail = max(run.w, run2.w);
  vec3 small = beads(uv, 34.0, 1.0, t, 0.42 + 0.18 * heavy) * (1.0 - trail);
  vec3 fine = beads(uv + 0.31, 70.0, 2.0, t * 1.3, 0.35 + 0.2 * heavy) * (1.0 - trail);

  vec2 bigNormal = run.xy + run2.xy * step(run.z, 0.01);
  float big = max(run.z, run2.z);
  vec2 normal = bigNormal + small.xy * 0.7 + fine.xy * 0.5;
  float cover = max(big, max(small.z, fine.z) * 0.8);

  // Through a drop: a wider, sharper, upside-down view of the city around it. On the glass:
  // soft, behind a little mist.
  vec2 bend = -bigNormal * 0.34 - (small.xy + fine.xy) * 0.09;
  float focus = max(cover * 0.55, trail * 0.3);
  vec3 col = city(uv + bend, focus, t, aspect) * (1.0 + 0.25 * cover);

  float mist = (0.6 + 0.4 * noise(uv * 2.5 + vec2(0.0, t * 0.01))) * (1.0 - trail * 0.85) * (1.0 - cover);
  col = mix(col, col * 0.75 + srgb(vec3(0.12, 0.09, 0.15)) * 0.3, mist * 0.5);

  // Each drop: a darker rim where it bends light away, a highlight at its upper left.
  float edge = length(normal);
  col *= 1.0 - 0.32 * smoothstep(0.7, 1.0, length(bigNormal)) * big;
  float spec = pow(max(dot(normal, normalize(vec2(-0.45, 0.8))), 0.0), 5.0) * cover;
  col += srgb(vec3(0.85, 0.9, 1.0)) * spec * (0.06 + 0.1 * big);

  col *= 1.0 - 0.3 * smoothstep(0.6, 1.3, length((uv - vec2(0.5 * aspect, 0.5)) * vec2(0.9, 1.1)));
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
      throw new Error(`rain-city shader: ${gl.getShaderInfoLog(shader)}`);
    return shader;
  }

  function build() {
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.bindAttribLocation(program, 0, "corner");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(`rain-city program: ${gl.getProgramInfoLog(program)}`);
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
      if (!gl) throw new Error("rain-city needs WebGL 2");
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
