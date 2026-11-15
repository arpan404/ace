/*
 * Mizzle's backdrop: rain on a window pane, over a city far out of focus. At night (dark scheme)
 * street lamps, lit windows, signals and slow cars glow as wide discs behind misted glass; by day
 * (light scheme) the same street sits pale under an overcast sky.
 *
 * The glass is simulated, not drawn from a pattern. Rain lands at random; small droplets bead and
 * stay put. A drop that grows past what the glass can hold (each one its own limit) slides down,
 * stops and starts again at rough spots, sweeps up the droplets in its path, sheds a line of
 * small ones behind it and clears the mist, which slowly forms again.
 *
 * Each frame, at reduced resolution:
 *   1. the city as the eye sees it through clear glass (wide discs), and as a drop focuses it
 *      (points), each rendered by one shader;
 *   2. the city through mist: the first one blurred further;
 *   3. the mist map: cleared where drops ran, fading back to mist;
 *   4. the water: every drop and droplet added into one height field;
 *   5. the picture: through each drop the focused city, refracted and upside down, with a dark
 *      rim and a small highlight; between drops the glass, misted or clear.
 *
 * Signals are small: working brings heavier rain, waiting warms the lights, failed dims the
 * city for a moment, done and a merged pull request brighten the lights softly.
 */
/** A seeded generator, so the rain is the same rain for the same seed. */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
/** 0 → 1 over `rise` ms, held `hold` ms, back to 0 over `fall` ms; `age` is ms since. */
const swell = (age, rise, hold, fall) =>
  age < 0 ? 0 : age < rise + hold ? ease(age / rise) : 1 - ease((age - rise - hold) / fall);
/** A drop's volume from its radius, and back: drops that merge keep their water. */
const volume = (r) => r * r * r;
const radius = (v) => Math.cbrt(Math.max(v, 0));

(() => {
  "use strict";

  /* ── Tuning ────────────────────────────────────────────────────────────────────────────── */

  /** Backing pixels per CSS pixel: well under the device's, scaled up smoothly by the browser. */
  const DETAIL = 0.62;
  const MIN_SCALE = 0.8;
  /** At most this many backing pixels, whatever the window. */
  const MAX_PIXELS = 1_500_000;
  /** Scene seconds simulated before the first frame, so the pane starts lived-in. */
  const WARM_UP = 75;
  /** The still frame under Reduce motion: this many seconds into the same seeded rain. */
  const STILL_AT = 75;
  /** Simulation step in seconds; frames take as many as they need. */
  const STEP = 1 / 30;

  /** Pools. Droplets are counted per million CSS px² of glass. */
  const BEAD_CAP = 9000;
  const DROP_CAP = 420;
  const BEADS_PER_MPX = 4200;
  /** Rain landing on the glass, per second per million CSS px². */
  const RAIN = 46;
  /** A landed drop bigger than this (CSS px radius) is a drop, not a droplet. */
  const PROMOTE = 3.6;
  /** Slowest and fastest a drop slides, CSS px per second. */
  const SLIDE_MIN = 14;
  const SLIDE_MAX = 190;
  /** Seconds for a cleared trail to mist over again. */
  const REFOG = 20;
  /** How far a drop's lens reaches, as a share of the window's height. */
  const LENS = 0.24;

  /* ── Shaders ───────────────────────────────────────────────────────────────────────────── */

  const COMMON = `#version 300 es
precision highp float;
precision highp int;
uint mixBits(uint x) {
  x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
  return x;
}
// Non-negative integer cells only (callers offset them).
float hash(int a, int b) {
  return float(mixBits(uint(a) * 0x9e3779b9u ^ mixBits(uint(b) + 0x632be5abu))) * (1.0 / 4294967296.0);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  int x = int(i.x) + 8192;
  int y = int(i.y) + 8192;
  return mix(mix(hash(x, y), hash(x + 1, y), f.x), mix(hash(x, y + 1), hash(x + 1, y + 1), f.x), f.y);
}
`;

  const FULL_VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  /*
   * The city. Coordinates in screen heights, y up: x from 0 to the aspect. Every light is a
   * point of some energy; the lens draws it as a disc of radius R that keeps its total light,
   * so the discs through clear glass are wide and dim and the points in a drop small and bright.
   * The disc size is the same at every distance, as it is for a lens focused on a near pane.
   */
  const CITY = `${COMMON}
uniform vec2 res;
uniform float aspect;
uniform float time;
uniform float focus; // 0 through clear glass, 1 as a drop focuses it
uniform float day;
uniform vec3 mood;   // warm, dim, bright: each 0..1
uniform float store; // stored values are divided by this, for targets that can't hold more than 1
out vec4 outColor;

const float BOKEH = 0.036;
float R;
float px;
float soft;
vec3 tint;   // the lights' colour shift (waiting warms it)
float gain;  // the lights' strength (done brightens, failed dims)

const vec3 SODIUM = vec3(1.0, 0.47, 0.13);
const vec3 TUNGSTEN = vec3(1.0, 0.66, 0.36);
const vec3 WARMLED = vec3(1.0, 0.82, 0.62);
const vec3 COOLLED = vec3(0.78, 0.86, 1.0);
const vec3 SCREEN = vec3(0.52, 0.66, 1.0);
const vec3 TAIL = vec3(1.0, 0.07, 0.04);
const vec3 HEAD = vec3(1.0, 0.91, 0.78);

// One point light of energy e at c, as the lens draws it: a disc a little brighter at its rim.
vec3 lamp(vec2 p, vec2 c, vec3 colour, float e) {
  vec2 d = p - c;
  float dd = dot(d, d);
  if (dd > R * R * 1.1) return vec3(0.0);
  float r = sqrt(dd);
  float body = 1.0 - smoothstep(R - soft, R, r);
  float rim = smoothstep(R * 0.55, R, r) * body;
  return colour * e * (body * 0.86 + rim * 0.28) * (BOKEH * BOKEH) / (R * R);
}

// The soft haze rain puts round a strong light, whatever the lens does.
vec3 haze(vec2 p, vec2 c, vec3 colour, float e, float reach) {
  float d = length(p - c);
  return colour * e * 0.09 * exp(-d / reach);
}

// The light a lamp throws on the wet road: a column under it, fading downward.
vec3 streak(vec2 p, float x, float top, vec3 colour, float e) {
  if (p.y > top) return vec3(0.0);
  float w = max(R * 0.55, 0.004);
  float across = exp(-pow((p.x - x) / w, 2.0));
  float down = exp(-(top - p.y) / 0.07);
  return colour * e * 0.16 * across * down;
}

// Roof height of a row of blocks at x: each block its own width share and height.
float roof(float x, float width, float low, float high, int seed) {
  int id = int(floor(x / width)) + 4096;
  float h = hash(id, seed);
  float tower = hash(id, seed + 1) > 0.84 ? 1.3 : 1.0;
  return low + (high - low) * (0.22 + 0.78 * h * h) * tower;
}
// How much of p is building, softened over the lens's blur.
float buildings(vec2 p, float width, float low, float high, int seed) {
  float m = 0.0;
  for (int k = -1; k <= 1; k++) {
    float top = roof(p.x + float(k) * soft * 0.9, width, low, high, seed);
    m += 1.0 - smoothstep(top - soft, top + soft, p.y);
  }
  return m / 3.0;
}

float gapCentre;
const float GAP = 0.15;
// The cross street between the near buildings, as a 0..1 opening at x.
float gap(float x) {
  float d = abs(x - gapCentre);
  return 1.0 - smoothstep(GAP - soft, GAP + soft, d);
}
float nearTop(float x) { return roof(x, 0.23, 0.52, 0.86, 23); }

void main() {
  vec2 p = vec2(gl_FragCoord.x / res.x * aspect, gl_FragCoord.y / res.y);
  px = 1.0 / res.y;
  R = mix(BOKEH, max(px * 1.8, 0.005), focus);
  soft = mix(BOKEH * 0.75, px * 1.2, focus);
  tint = mix(vec3(1.0), vec3(1.07, 0.97, 0.82), mood.x);
  gain = (1.0 + 0.32 * mood.z) * (1.0 - 0.45 * mood.y);
  gapCentre = aspect * 0.6;
  float t = time;

  // Sky: night lit low and warm by the city under cloud; by day a flat, bright overcast.
  float cloud = vnoise(vec2(p.x * 1.6 + t * 0.006, p.y * 3.0)) * 0.6 + vnoise(vec2(p.x * 4.1 - t * 0.004, p.y * 7.0)) * 0.4;
  vec3 night = mix(vec3(0.058, 0.040, 0.032), vec3(0.0075, 0.0095, 0.016), smoothstep(0.3, 1.0, p.y));
  night += vec3(0.022, 0.015, 0.012) * cloud * (1.0 - smoothstep(0.45, 1.0, p.y));
  vec3 overcast = mix(vec3(0.66, 0.68, 0.70), vec3(0.54, 0.58, 0.63), smoothstep(0.35, 1.0, p.y));
  overcast += vec3(0.045) * (cloud - 0.5);
  vec3 col = mix(night, overcast, day);

  // Far skyline, and the glow of the windows too small and many to see one by one.
  float far = buildings(p, 0.055, 0.32, 0.55, 11);
  float glowField = vnoise(p * vec2(18.0, 26.0)) * vnoise(p * vec2(7.0, 5.0) + 3.0);
  vec3 farNight = vec3(0.011, 0.011, 0.015) + TUNGSTEN * glowField * 0.02;
  vec3 farDay = vec3(0.43, 0.46, 0.50) + vec3(0.03) * glowField;
  col = mix(col, mix(farNight, farDay, day), far * 0.92);

  // Far lights, hidden where the near buildings stand in front.
  vec3 lights = vec3(0.0);
  {
    vec2 cell = vec2(0.05, 0.034);
    vec2 q = p / cell;
    ivec2 base = ivec2(floor(q)) + 4096;
    for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      ivec2 c = base + ivec2(i, j);
      vec2 at = (vec2(c - 4096) + 0.15 + 0.7 * vec2(hash(c.x, c.y + 11), hash(c.x + 5, c.y))) * cell;
      float h = hash(c.x + 9, c.y + 3);
      if (h < 0.42) continue;
      if (at.y > roof(at.x, 0.055, 0.32, 0.55, 11) - 0.008) continue;
      if (at.y < 0.30) continue;
      float behind = gap(at.x) + (1.0 - gap(at.x)) * step(nearTop(at.x), at.y);
      if (behind < 0.5) continue;
      float k = hash(c.x + 2, c.y + 7);
      vec3 colour = k < 0.45 ? TUNGSTEN : k < 0.75 ? SODIUM : k < 0.95 ? COOLLED : SCREEN;
      float on = day > 0.5 ? step(0.8, k) * 0.35 : 1.0;
      lights += lamp(p, at, colour, (0.10 + 0.22 * h) * on);
    }
  }
  // Red lights on the tallest far roofs, breathing slowly.
  for (int k = 0; k < 2; k++) {
    float x = aspect * (k == 0 ? 0.31 : 0.83);
    float top = roof(x, 0.055, 0.32, 0.55, 11);
    if (top < nearTop(x) && gap(x) < 0.5) continue;
    float breathe = 0.55 + 0.45 * sin(t * 0.9 + float(k) * 2.1);
    lights += lamp(p, vec2(x, top + 0.006), TAIL, 0.22 * breathe);
  }

  // The near buildings across the street, open where the cross street runs.
  float near = buildings(p, 0.23, 0.52, 0.86, 23) * (1.0 - gap(p.x)) * step(0.12, p.y);
  float facadeGlow = vnoise(p * vec2(9.0, 12.0) + 11.0);
  vec3 nearNight = vec3(0.0065, 0.0068, 0.0085) + WARMLED * facadeGlow * facadeGlow * 0.012;
  vec3 nearDay = vec3(0.30, 0.32, 0.35) + vec3(0.035) * (facadeGlow - 0.5);
  col = mix(col, mix(nearNight, nearDay, day), near);

  // Lit windows on the near buildings.
  {
    vec2 cell = vec2(0.075, 0.062);
    vec2 q = p / cell;
    ivec2 base = ivec2(floor(q)) + 4096;
    for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      ivec2 c = base + ivec2(i, j);
      vec2 at = (vec2(c - 4096) + 0.2 + 0.6 * vec2(hash(c.x + 1, c.y + 21), hash(c.x + 13, c.y + 2))) * cell;
      float h = hash(c.x + 17, c.y + 5);
      float lit = day > 0.5 ? 0.82 : 0.5;
      if (h < lit) continue;
      if (at.y < 0.3 || at.y > nearTop(at.x) - 0.03 || gap(at.x) > 0.5) continue;
      float k = hash(c.x + 4, c.y + 19);
      vec3 colour = k < 0.6 ? TUNGSTEN : k < 0.85 ? WARMLED : k < 0.95 ? COOLLED : SCREEN;
      float flicker = colour == SCREEN ? 0.8 + 0.2 * sin(t * 0.7 + h * 30.0) : 1.0;
      lights += lamp(p, at, colour, (0.16 + 0.3 * h) * flicker * (day > 0.5 ? 0.55 : 1.0));
    }
  }

  // The cross street, running away to a point between the buildings.
  vec2 vanish = vec2(gapCentre, 0.33);
  for (int k = 1; k <= 6; k++) {
    float z = 1.0 + float(k) * 0.85;
    for (int side = 0; side < 2; side++) {
      vec2 foot = vec2(gapCentre + (side == 0 ? -0.2 : 0.2), 0.27);
      vec2 at = vanish + (foot - vanish) / z;
      float e = (day > 0.5 ? 0.0 : 0.9) / pow(z, 0.8);
      vec3 colour = hash(k + 40, side) < 0.5 ? SODIUM : WARMLED;
      lights += lamp(p, at, colour, e);
    }
  }
  // Cars on it: headlights coming, tail lights going.
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    float coming = 7.0 - mod(t * 0.16 + fk * 2.3, 6.0);
    float going = 1.0 + mod(t * 0.13 + fk * 2.1 + 1.0, 6.0);
    vec2 inLane = vanish + (vec2(gapCentre + 0.05, 0.12) - vanish) / coming;
    vec2 outLane = vanish + (vec2(gapCentre - 0.07, 0.12) - vanish) / going;
    float fadeIn = smoothstep(7.0, 6.2, coming) * smoothstep(1.0, 1.6, coming);
    float fadeOut = smoothstep(7.0, 6.2, going) * smoothstep(1.0, 1.6, going);
    float pairIn = 0.035 / coming;
    float pairOut = 0.03 / going;
    lights += lamp(p, inLane - vec2(pairIn, 0.0), HEAD, 0.5 * fadeIn / coming);
    lights += lamp(p, inLane + vec2(pairIn, 0.0), HEAD, 0.5 * fadeIn / coming);
    lights += lamp(p, outLane - vec2(pairOut, 0.0), TAIL, 0.32 * fadeOut / going);
    lights += lamp(p, outLane + vec2(pairOut, 0.0), TAIL, 0.32 * fadeOut / going);
  }

  // A traffic signal at the corner: green, a short amber, red, with soft changes.
  {
    float cycle = mod(t, 48.0);
    float green = smoothstep(0.0, 1.2, cycle) * (1.0 - smoothstep(22.0, 23.2, cycle));
    float amber = smoothstep(22.0, 23.2, cycle) * (1.0 - smoothstep(26.0, 27.2, cycle));
    float red = smoothstep(26.0, 27.2, cycle) * (1.0 - smoothstep(46.8, 48.0, cycle));
    vec2 head = vec2(gapCentre - 0.25, 0.215);
    float e = day > 0.5 ? 0.35 : 0.55;
    lights += lamp(p, head, vec3(0.12, 1.0, 0.62), e * green);
    lights += lamp(p, head + vec2(0.0, 0.012), vec3(1.0, 0.55, 0.05), e * amber);
    lights += lamp(p, head + vec2(0.0, 0.024), vec3(1.0, 0.08, 0.05), e * red);
    lights += lamp(p, vec2(gapCentre + 0.27, 0.205), vec3(1.0, 0.08, 0.05), e * green);
    lights += lamp(p, vec2(gapCentre + 0.27, 0.193), vec3(0.12, 1.0, 0.62), e * red);
  }

  // The street below: wet asphalt, lamps along the near side, and their light on the road.
  float road = 1.0 - smoothstep(0.13, 0.145, p.y);
  vec3 asphaltNight = vec3(0.0055, 0.0055, 0.0065);
  vec3 asphaltDay = vec3(0.24, 0.255, 0.275);
  col = mix(col, mix(asphaltNight, asphaltDay, day), road);
  // The sky and buildings, faint in the water on the road.
  col += road * mix(vec3(0.004, 0.003, 0.003), vec3(0.08), day) * smoothstep(0.0, 0.13, p.y);

  int lampsAcross = int(ceil(aspect / 0.32)) + 1;
  for (int k = 0; k < 9; k++) {
    if (k >= lampsAcross) break;
    float h = hash(k + 60, 1);
    if (h < 0.12) continue;
    vec2 at = vec2((float(k) + 0.25 + 0.5 * hash(k + 60, 2)) * 0.32, 0.25 + 0.02 * hash(k + 60, 3));
    vec3 colour = h < 0.62 ? SODIUM : WARMLED;
    float e = day > 0.5 ? (h > 0.85 ? 0.35 : 0.0) : 1.25;
    lights += lamp(p, at, colour, e);
    lights += haze(p, at, colour, e, 0.07);
    lights += streak(p, at.x, 0.13, colour, e);
  }

  // Cars along the street, both ways, slow: a white light ahead and a red one behind.
  for (int lane = 0; lane < 2; lane++) {
    float y = lane == 0 ? 0.105 : 0.06;
    float dir = lane == 0 ? -1.0 : 1.0;
    float span = aspect + 0.7;
    for (int k = 0; k < 4; k++) {
      float fk = float(k);
      float run = t * (0.05 + 0.012 * float(lane)) + fk * span / 4.0 + float(lane) * 0.37;
      float lap = floor(run / span);
      if (hash(int(lap) + 900, k + lane * 8) < 0.3) continue;
      float x = mod(run, span) - 0.35;
      x = dir > 0.0 ? x : aspect - x;
      vec2 front = vec2(x, y);
      vec2 back = vec2(x - dir * 0.11, y + 0.004);
      lights += lamp(p, front, HEAD, 0.7);
      lights += haze(p, front, HEAD, 0.5, 0.04);
      lights += lamp(p, back, TAIL, 0.4);
      lights += streak(p, front.x, y - 0.01, HEAD, 0.35);
      lights += streak(p, back.x, y - 0.01, TAIL, 0.25);
    }
  }

  col += lights * tint * gain;
  col *= 1.0 - 0.38 * mood.y;
  outColor = vec4(col / store, 1.0);
}`;

  /** The city through mist: the clear-glass city blurred over a wide disc. */
  const MIST = `${COMMON}
uniform sampler2D city;
uniform vec2 res;
uniform float reach; // in UV heights
uniform float aspect;
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / res;
  vec3 sum = texture(city, uv).rgb;
  float total = 1.0;
  for (int i = 0; i < 18; i++) {
    float a = float(i) * 2.39996;
    float r = sqrt((float(i) + 0.5) / 18.0) * reach;
    vec2 at = uv + vec2(cos(a) / aspect, sin(a)) * r;
    sum += texture(city, at).rgb;
    total += 1.0;
  }
  outColor = vec4(sum / total, 1.0);
}`;

  /** Mist forming again: the mist map loses a little clarity each step. */
  const FADE = `#version 300 es
precision highp float;
uniform float amount;
out vec4 outColor;
void main() { outColor = vec4(amount); }`;

  /** A sliding drop's sweep: a capsule from where it was to where it is, cleared of mist. */
  const WIPE_VERTEX = `#version 300 es
in vec4 segment; // ax, ay, bx, by in CSS px, y down
in float width;  // CSS px
uniform vec2 view;
out vec2 here;
flat out vec4 seg;
flat out float w;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  vec2 lo = min(segment.xy, segment.zw) - width;
  vec2 hi = max(segment.xy, segment.zw) + width;
  here = mix(lo, hi, corner);
  seg = segment;
  w = width;
  vec2 clip = here / view * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;
  const WIPE = `#version 300 es
precision highp float;
in vec2 here;
flat in vec4 seg;
flat in float w;
out vec4 outColor;
void main() {
  vec2 ab = seg.zw - seg.xy;
  float t = clamp(dot(here - seg.xy, ab) / max(dot(ab, ab), 1e-4), 0.0, 1.0);
  float d = length(here - seg.xy - ab * t);
  float a = 1.0 - smoothstep(w * 0.55, w, d);
  outColor = vec4(1.0, 1.0, 1.0, a * 0.9);
}`;

  /** Each drop and droplet, added into the water's height field. */
  const SPLAT_VERTEX = `#version 300 es
in vec4 drop; // x, y in CSS px (y down), radius in CSS px, stretch 0..1
uniform vec2 view;
uniform float scale; // backing px per CSS px
const float SPREAD = 1.488; // splat radius over the visible radius (see WATER in the pane)
out vec2 local;
out float stretch;
out float size;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1)) * 2.0 - 1.0;
  float r = drop.z * SPREAD;
  float up = 1.0 + drop.w * 1.7;
  // The quad: a little below the drop's centre and well above it, for a sliding drop's tail.
  vec2 offset = vec2(corner.x * r * 1.05, corner.y < 0.0 ? -r * 1.05 : r * up * 1.05);
  local = offset / r;
  stretch = drop.w;
  size = drop.z * SPREAD * scale;
  vec2 at = drop.xy + vec2(offset.x, -offset.y);
  vec2 clip = at / view * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;
  const SPLAT = `#version 300 es
precision highp float;
in vec2 local;
in float stretch;
in float size;
out vec4 outColor;
void main() {
  vec2 k = local;
  if (k.y > 0.0) {
    // Above the centre a sliding drop draws out into a narrowing tail.
    k.y /= 1.0 + stretch * 1.7;
    k.x *= 1.0 + stretch * 0.9 * k.y;
  } else {
    // Below, its leading edge is a little fuller.
    k.y *= 1.0 - 0.1 * stretch;
  }
  float d2 = dot(k, k);
  if (d2 >= 1.0) discard;
  float f = 1.0 - d2;
  // r: the water's height in backing px; g: how much is water, summed so drops that touch merge.
  outColor = vec4(size * f * 0.5, f * f, 0.0, 0.0);
}`;

  /** The picture: drops as lenses on misted glass. */
  const PANE = `${COMMON}
uniform sampler2D water;
uniform sampler2D city;
uniform sampler2D sharp;
uniform sampler2D mist;
uniform sampler2D cleared;
uniform vec2 res;
uniform float lens;  // backing px of view shift per unit of slope
uniform float day;
uniform float range; // what one unit stored in the city textures is worth
uniform float heights; // what one unit stored in the water's height is worth, in backing px
out vec4 outColor;

const float WATER = 0.3; // the summed field above which glass is under water
const float EDGE = 0.672; // a lone drop's slope at its visible edge

void main() {
  ivec2 ip = ivec2(gl_FragCoord.xy);
  ivec2 top = ivec2(res) - 1;
  vec2 uv = gl_FragCoord.xy / res;
  vec4 w = texelFetch(water, ip, 0);
  vec4 wl = texelFetch(water, max(ip - ivec2(1, 0), ivec2(0)), 0);
  vec4 wr = texelFetch(water, min(ip + ivec2(1, 0), top), 0);
  vec4 wd = texelFetch(water, max(ip - ivec2(0, 1), ivec2(0)), 0);
  vec4 wu = texelFetch(water, min(ip + ivec2(0, 1), top), 0);
  vec2 slope = vec2(wr.r - wl.r, wu.r - wd.r) * 0.5 * heights;
  float edge = max(length(vec2(wr.g - wl.g, wu.g - wd.g)) * 0.5, 0.02);
  float wet = smoothstep(WATER - edge, WATER + edge, w.g);

  // The glass: misted, or clear where drops ran and the mist hasn't formed again.
  vec3 through = texture(city, uv).rgb * range;
  vec3 misty = texture(mist, uv).rgb * range;
  vec3 veil = textureLod(mist, uv, 3.0).rgb * range;
  float thick = 0.62 + 0.3 * vnoise(uv * vec2(3.0, 2.2) + 7.0) + 0.12 * (1.0 - uv.y);
  float clear = texture(cleared, uv).r;
  // Mist forms back unevenly, from tiny points, so a fading trail's edge is ragged.
  float grain = vnoise(gl_FragCoord.xy * 0.22) * 0.6 + vnoise(gl_FragCoord.xy * 0.07) * 0.4;
  float from = 0.08 + 0.45 * grain;
  // A cleared trail keeps a thin film of water, so it is never quite as clear as dry glass.
  float fog = clamp(thick * mix(1.0, 0.86, day), 0.0, 1.0) * (1.0 - 0.82 * smoothstep(from, from + 0.18, clear));
  vec3 fogged = mix(misty, veil, 0.4) * mix(0.8, 0.9, day) + mix(vec3(0.0035, 0.0035, 0.0045), vec3(0.06, 0.062, 0.066), day);
  vec3 glass = mix(through, fogged, fog);

  // Through a drop: the focused city, shifted against the slope, so it shows upside down.
  vec2 seen = uv + slope * lens / res;
  vec3 lensed = texture(sharp, seen).rgb * range;
  lensed = lensed * mix(1.3, 1.0, day) + mix(vec3(0.002), vec3(0.03), day);
  float steep = length(slope);
  // The rim: light bent past the eye at the drop's steep edge, so it reads dark.
  float rim = smoothstep(0.68, 1.0, steep / EDGE);
  lensed *= 1.0 - mix(0.82, 0.7, day) * rim;
  // A small highlight from a light above and to the left, and a soft one under it.
  vec3 normal = normalize(vec3(-slope * 1.9, 1.0));
  vec3 halfway = normalize(vec3(-0.28, 0.42, 1.0) + vec3(0.0, 0.0, 1.0));
  float sharpSpec = pow(max(dot(normal, halfway), 0.0), 160.0);
  float broadSpec = pow(max(dot(normal, halfway), 0.0), 18.0) * (1.0 - rim);
  lensed += mix(vec3(0.62, 0.66, 0.74), vec3(1.4), day) * sharpSpec * 0.55;
  lensed += mix(vec3(0.010, 0.011, 0.014), vec3(0.08), day) * broadSpec;

  vec3 col = mix(glass, lensed, wet);

  // Light to screen: a soft shoulder, then display values, with a fixed dither against banding.
  col = 1.0 - exp(-max(col, 0.0) * mix(2.6, 1.55, day));
  col = pow(col, vec3(1.0 / 2.2));
  col += (hash(ip.x + 4096, ip.y + 4096) - 0.5) / 255.0;
  outColor = vec4(col, 1.0);
}`;

  /* ── The glass: droplets and drops ─────────────────────────────────────────────────────── */

  const CELL = 24; // grid cell for finding droplets, CSS px
  let random = seeded(1115);
  let W = 1;
  let H = 1;
  // Droplets: still, small.
  const bx = new Float32Array(BEAD_CAP);
  const by = new Float32Array(BEAD_CAP);
  const br = new Float32Array(BEAD_CAP);
  let beads = 0;
  // Drops: may slide.
  const dx = new Float32Array(DROP_CAP);
  const dy = new Float32Array(DROP_CAP);
  const dr = new Float32Array(DROP_CAP);
  const dv = new Float32Array(DROP_CAP); // speed down, px/s
  const dslope = new Float32Array(DROP_CAP); // sideways px per px down
  const dstuck = new Float32Array(DROP_CAP); // seconds left held
  const dshed = new Float32Array(DROP_CAP); // px slid since the last shed droplet
  const dhold = new Float32Array(DROP_CAP); // the radius this drop's spot of glass can hold
  const dphase = new Float32Array(DROP_CAP); // where its path's meander starts
  let drops = 0;
  // The droplet grid, rebuilt each step.
  let gridW = 1;
  let gridH = 1;
  let head = new Int32Array(1);
  const next = new Int32Array(BEAD_CAP);
  // Sweeps for the mist map, one per sliding drop per step.
  const sweeps = new Float32Array(DROP_CAP * 5);
  let sweepCount = 0;
  let rainOwed = 0;

  function resetGlass(seed) {
    random = seeded(seed);
    beads = 0;
    drops = 0;
    rainOwed = 0;
  }

  function sizeGlass(width, height) {
    W = Math.max(1, width);
    H = Math.max(1, height);
    gridW = Math.ceil(W / CELL) + 1;
    gridH = Math.ceil(H / CELL) + 1;
    head = new Int32Array(gridW * gridH);
    // Anything now off the glass goes.
    let kept = 0;
    for (let i = 0; i < beads; i++) {
      if (bx[i] > W + 4 || by[i] > H + 4) continue;
      bx[kept] = bx[i];
      by[kept] = by[i];
      br[kept] = br[i];
      kept++;
    }
    beads = kept;
    rebuildGrid();
  }

  function cellOf(x, y) {
    const cx = Math.min(gridW - 1, Math.max(0, Math.floor(x / CELL)));
    const cy = Math.min(gridH - 1, Math.max(0, Math.floor(y / CELL)));
    return cy * gridW + cx;
  }

  function rebuildGrid() {
    head.fill(-1);
    for (let i = 0; i < beads; i++) {
      const c = cellOf(bx[i], by[i]);
      next[i] = head[c];
      head[c] = i;
    }
  }

  /** Droplets swallowed in a step are zeroed, then dropped here. */
  function compactBeads() {
    let kept = 0;
    for (let i = 0; i < beads; i++) {
      if (br[i] <= 0) continue;
      if (kept !== i) {
        bx[kept] = bx[i];
        by[kept] = by[i];
        br[kept] = br[i];
      }
      kept++;
    }
    beads = kept;
  }

  function addBead(x, y, r) {
    if (beads >= BEAD_CAP || x < -4 || x > W + 4 || y < -4 || y > H + 4) return;
    bx[beads] = x;
    by[beads] = y;
    br[beads] = r;
    const c = cellOf(x, y);
    next[beads] = head[c];
    head[c] = beads;
    beads++;
  }

  function addDrop(x, y, r) {
    if (drops >= DROP_CAP) {
      addBead(x, y, Math.min(r, PROMOTE));
      return;
    }
    const i = drops++;
    dx[i] = x;
    dy[i] = y;
    dr[i] = r;
    dv[i] = 0;
    dslope[i] = (random() - 0.5) * 0.12;
    dstuck[i] = 0;
    dshed[i] = 0;
    // Glass is uneven: each spot holds a drop of its own size before letting go.
    dhold[i] = 5.4 + random() * random() * 6;
    dphase[i] = random() * 6.283;
  }

  /** Drops merged away or run off the glass are zeroed during a step, then dropped here. */
  function compactDrops() {
    let kept = 0;
    for (let i = 0; i < drops; i++) {
      if (dr[i] <= 0) continue;
      if (kept !== i) {
        dx[kept] = dx[i];
        dy[kept] = dy[i];
        dr[kept] = dr[i];
        dv[kept] = dv[i];
        dslope[kept] = dslope[i];
        dstuck[kept] = dstuck[i];
        dshed[kept] = dshed[i];
        dhold[kept] = dhold[i];
        dphase[kept] = dphase[i];
      }
      kept++;
    }
    drops = kept;
  }

  /**
   * Swallows every droplet that (x, y, r) touches and returns the volume taken. `reach` scales
   * how close counts as touching.
   */
  function swallow(x, y, r, reach) {
    let taken = 0;
    const span = r + PROMOTE;
    const x0 = Math.max(0, Math.floor((x - span) / CELL));
    const x1 = Math.min(gridW - 1, Math.floor((x + span) / CELL));
    const y0 = Math.max(0, Math.floor((y - span) / CELL));
    const y1 = Math.min(gridH - 1, Math.floor((y + span) / CELL));
    for (let cy = y0; cy <= y1; cy++)
      for (let cx = x0; cx <= x1; cx++)
        for (let j = head[cy * gridW + cx]; j !== -1; j = next[j]) {
          const rb = br[j];
          if (rb <= 0) continue;
          const ox = bx[j] - x;
          const oy = by[j] - y;
          const touch = (r + rb) * reach;
          if (ox * ox + oy * oy < touch * touch) {
            taken += volume(rb);
            br[j] = 0;
          }
        }
    return taken;
  }

  /**
   * Rain lands: mostly fine, now and then a large drop, and it joins whatever it lands on. On a
   * crowded pane most fine drops are skipped, so the droplets settle at a natural density.
   */
  function land(wetter, crowded) {
    const big = random() < 0.07 * (1 + wetter);
    if (!big && crowded > 1 && random() < 0.8) return;
    const x = random() * W;
    const y = random() * H;
    let r = big ? 3.6 + random() * random() * 8 : 0.5 + 2.9 * random() ** 1.9;
    for (let i = 0; i < drops; i++) {
      if (dr[i] <= 0) continue;
      const ox = dx[i] - x;
      const oy = dy[i] - y;
      const touch = dr[i] + r * 0.7;
      if (ox * ox + oy * oy < touch * touch) {
        dr[i] = radius(volume(dr[i]) + volume(r));
        return;
      }
    }
    const taken = swallow(x, y, r, 0.9);
    if (taken > 0) r = radius(volume(r) + taken);
    if (r >= PROMOTE) addDrop(x, y, r);
    else addBead(x, y, r);
  }

  /** One sliding drop for `dt` seconds: held, or moving, sweeping and shedding. */
  function slide(i, dt, wetter) {
    const r = dr[i];
    if (r <= dhold[i]) {
      dv[i] = 0;
      return;
    }
    if (dstuck[i] > 0) {
      dstuck[i] -= dt;
      return;
    }
    const drive = (r - dhold[i]) / dhold[i];
    const pace = Math.min(SLIDE_MAX, SLIDE_MIN + 150 * drive) * (1 + 0.2 * wetter);
    dv[i] += (pace - dv[i]) * Math.min(1, dt * 3.5);
    const down = dv[i] * dt;
    const fromX = dx[i];
    const fromY = dy[i];
    dy[i] += down;
    // Its path meanders a little as it finds the easier way down.
    const y = dy[i];
    const p = dphase[i];
    dx[i] +=
      (dslope[i] + 0.08 * Math.sin(y * 0.031 + p) + 0.05 * Math.sin(y * 0.087 + p * 2.3)) * down;

    // A rough spot holds it a moment; heavy drops are held less. It sets off a little askew.
    if (random() < down * 0.011 * (dhold[i] / r) ** 3) {
      dstuck[i] = 0.12 + random() * random() * 2.2;
      dv[i] *= 0.15;
      dslope[i] = Math.max(-0.35, Math.min(0.35, dslope[i] * 0.4 + (random() - 0.5) * 0.36));
    }

    // It sweeps up the droplets in its way, and leaves a line of small ones up its trail.
    let v = volume(r) + swallow(dx[i], dy[i], r, 0.95);
    dshed[i] += down;
    if (dshed[i] > r * (1.1 + random() * 2.4)) {
      dshed[i] = 0;
      const shed = r * (0.16 + 0.2 * random());
      addBead(dx[i] + (random() - 0.5) * r * 0.35, dy[i] - r * (0.85 + random() * 0.4), shed);
      v -= volume(shed);
    }
    dr[i] = radius(v);

    if (sweepCount < DROP_CAP) {
      const s = sweepCount * 5;
      sweeps[s] = fromX;
      sweeps[s + 1] = fromY - r * 0.4;
      sweeps[s + 2] = dx[i];
      sweeps[s + 3] = dy[i];
      sweeps[s + 4] = r * (1.05 + 0.25 * random());
      sweepCount++;
    }
    if (dy[i] - r > H + 6) dr[i] = 0;
  }

  /** Every moving drop that touches another becomes one with it, where the heavier one was. */
  function merge() {
    for (let i = 0; i < drops; i++) {
      if (dv[i] === 0 || dr[i] <= 0) continue;
      for (let j = 0; j < drops; j++) {
        if (j === i || dr[j] <= 0) continue;
        const ox = dx[j] - dx[i];
        const oy = dy[j] - dy[i];
        const touch = (dr[i] + dr[j]) * 0.82;
        if (ox * ox + oy * oy >= touch * touch) continue;
        const vi = volume(dr[i]);
        const vj = volume(dr[j]);
        const a = vi >= vj ? i : j;
        const b = a === i ? j : i;
        const share = Math.min(vi, vj) / (vi + vj);
        dx[a] += (dx[b] - dx[a]) * share;
        dy[a] += (dy[b] - dy[a]) * share;
        dr[a] = radius(vi + vj);
        dv[a] = Math.max(dv[a], dv[b]);
        dstuck[a] = 0;
        dr[b] = 0;
        if (b === i) break;
      }
    }
  }

  /** One step of the glass: rain lands, heavy drops slide, drops that meet merge. */
  function step(dt, wetter) {
    sweepCount = 0;
    const area = (W * H) / 1e6;
    const crowded = beads / Math.max(1, BEADS_PER_MPX * area);
    rainOwed += dt * RAIN * area * (1 + 0.85 * wetter);
    while (rainOwed >= 1) {
      rainOwed -= 1;
      land(wetter, crowded);
    }
    for (let i = 0; i < drops; i++) if (dr[i] > 0) slide(i, dt, wetter);
    merge();
    compactDrops();
    compactBeads();
    rebuildGrid();
  }

  /** Every drop and droplet as (x, y, r, stretch) for the water pass. */
  const instances = new Float32Array((BEAD_CAP + DROP_CAP) * 4);
  function packWater() {
    let n = 0;
    for (let i = 0; i < beads; i++) {
      instances[n++] = bx[i];
      instances[n++] = by[i];
      instances[n++] = br[i];
      instances[n++] = 0;
    }
    for (let i = 0; i < drops; i++) {
      instances[n++] = dx[i];
      instances[n++] = dy[i];
      instances[n++] = dr[i];
      instances[n++] = Math.min(0.85, dv[i] / 150);
    }
    return beads + drops;
  }

  /* ── WebGL ─────────────────────────────────────────────────────────────────────────────── */

  let gl = null;
  let programs = null;
  let targets = null;
  let floatTargets = false;
  let waterBuffer = null;
  let sweepBuffer = null;
  let waterVao = null;
  let sweepVao = null;
  let emptyVao = null;
  let backing = { width: 1, height: 1, scale: 1 };
  let clock = 0; // scene seconds the city has run
  let fadeOwed = 0;
  let last = -1;
  let now = 0;
  let work = 0;
  let workUntil = -Infinity;
  let waitAt = -Infinity;
  let failAt = -Infinity;
  let doneAt = -Infinity;
  let mergeAt = -Infinity;
  let started = false;
  let stillDrawn = false;

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw new Error(`mizzle shader: ${gl.getShaderInfoLog(shader)}`);
    return shader;
  }

  function program(vertex, fragment, attributes, uniformNames) {
    const made = gl.createProgram();
    gl.attachShader(made, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(made, compile(gl.FRAGMENT_SHADER, fragment));
    attributes.forEach((name, index) => gl.bindAttribLocation(made, index, name));
    gl.linkProgram(made);
    if (!gl.getProgramParameter(made, gl.LINK_STATUS))
      throw new Error(`mizzle program: ${gl.getProgramInfoLog(made)}`);
    const uniforms = {};
    for (const name of uniformNames) uniforms[name] = gl.getUniformLocation(made, name);
    return { program: made, uniforms };
  }

  function buildPrograms() {
    programs = {
      city: program(
        FULL_VERTEX,
        CITY,
        [],
        ["res", "aspect", "time", "focus", "day", "mood", "store"],
      ),
      mist: program(FULL_VERTEX, MIST, [], ["city", "res", "reach", "aspect"]),
      fade: program(FULL_VERTEX, FADE, [], ["amount"]),
      wipe: program(WIPE_VERTEX, WIPE, ["segment", "width"], ["view"]),
      splat: program(SPLAT_VERTEX, SPLAT, ["drop"], ["view", "scale"]),
      pane: program(
        FULL_VERTEX,
        PANE,
        [],
        ["water", "city", "sharp", "mist", "cleared", "res", "lens", "day", "range", "heights"],
      ),
    };
    emptyVao = gl.createVertexArray();

    waterBuffer = gl.createBuffer();
    waterVao = gl.createVertexArray();
    gl.bindVertexArray(waterVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, waterBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, instances.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
    gl.vertexAttribDivisor(0, 1);

    sweepBuffer = gl.createBuffer();
    sweepVao = gl.createVertexArray();
    gl.bindVertexArray(sweepVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, sweepBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, sweeps.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 20, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 20, 16);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
  }

  function target(width, height, float, levelled) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    const levels = levelled ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1;
    gl.texStorage2D(gl.TEXTURE_2D, levels, float ? gl.RGBA16F : gl.RGBA8, width, height);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      levelled ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    return { texture, framebuffer, width, height };
  }

  function releaseTargets() {
    if (!targets) return;
    for (const made of Object.values(targets)) {
      gl.deleteTexture(made.texture);
      gl.deleteFramebuffer(made.framebuffer);
    }
    targets = null;
  }

  function buildTargets() {
    releaseTargets();
    const { width, height } = backing;
    const part = (n) => [Math.max(1, Math.round(width / n)), Math.max(1, Math.round(height / n))];
    targets = {
      city: target(...part(2), floatTargets, false),
      sharp: target(...part(3), floatTargets, true),
      mist: target(...part(8), floatTargets, true),
      cleared: target(...part(4), false, false),
      water: target(width, height, floatTargets, false),
    };
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.cleared.framebuffer);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function fit(view) {
    let scale = Math.min(view.pixelRatio, Math.max(MIN_SCALE, view.pixelRatio * DETAIL));
    const pixels = view.width * view.height * scale * scale;
    if (pixels > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / pixels);
    const width = Math.max(1, Math.round(view.width * scale));
    const height = Math.max(1, Math.round(view.height * scale));
    view.canvas.width = width;
    view.canvas.height = height;
    backing = { width, height, scale: width / Math.max(1, view.width) };
    buildTargets();
    sizeGlass(view.width, view.height);
  }

  function bindTexture(unit, made) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, made.texture);
  }

  function into(made) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, made ? made.framebuffer : null);
    gl.viewport(0, 0, made ? made.width : backing.width, made ? made.height : backing.height);
  }

  /** 8-bit targets store the city's light at 1/RANGE, so its bright lights aren't clipped. */
  const RANGE = 4;

  function drawCity(made, focus, view, mood) {
    const { program: city, uniforms } = programs.city;
    into(made);
    gl.useProgram(city);
    gl.uniform2f(uniforms.res, made.width, made.height);
    gl.uniform1f(uniforms.aspect, view.width / Math.max(1, view.height));
    gl.uniform1f(uniforms.time, clock);
    gl.uniform1f(uniforms.focus, focus);
    gl.uniform1f(uniforms.day, view.scheme === "light" ? 1 : 0);
    gl.uniform3f(uniforms.mood, mood[0], mood[1], mood[2]);
    gl.uniform1f(uniforms.store, floatTargets ? 1 : RANGE);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function mipmaps(made) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, made.texture);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  /** The city through clear glass, as a drop focuses it, and through mist. */
  function drawCities(view, mood) {
    gl.disable(gl.BLEND);
    gl.bindVertexArray(emptyVao);
    drawCity(targets.city, 0, view, mood);
    drawCity(targets.sharp, 1, view, mood);
    mipmaps(targets.sharp);

    const { program: mist, uniforms } = programs.mist;
    into(targets.mist);
    gl.useProgram(mist);
    bindTexture(0, targets.city);
    gl.uniform1i(uniforms.city, 0);
    gl.uniform2f(uniforms.res, targets.mist.width, targets.mist.height);
    gl.uniform1f(uniforms.reach, 0.075);
    gl.uniform1f(uniforms.aspect, view.width / Math.max(1, view.height));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    mipmaps(targets.mist);
  }

  /** The mist map: forming again everywhere, then cleared along this step's sweeps. */
  function drawMist(dt, view) {
    into(targets.cleared);
    gl.enable(gl.BLEND);
    fadeOwed += (dt / REFOG) * 255;
    const whole = Math.floor(fadeOwed);
    if (whole > 0) {
      fadeOwed -= whole;
      gl.useProgram(programs.fade.program);
      gl.uniform1f(programs.fade.uniforms.amount, whole / 255);
      gl.blendEquation(gl.FUNC_REVERSE_SUBTRACT);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.bindVertexArray(emptyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    if (sweepCount > 0) {
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(programs.wipe.program);
      gl.uniform2f(programs.wipe.uniforms.view, view.width, view.height);
      gl.bindVertexArray(sweepVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, sweepBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, sweeps, 0, sweepCount * 5);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, sweepCount);
    }
    gl.disable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
  }

  function drawWater(view) {
    into(targets.water);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const count = packWater();
    if (count === 0) return;
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(programs.splat.program);
    gl.uniform2f(programs.splat.uniforms.view, view.width, view.height);
    gl.uniform1f(programs.splat.uniforms.scale, backing.scale * (floatTargets ? 1 : 1 / 24));
    gl.bindVertexArray(waterVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, waterBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, instances, 0, count * 4);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.disable(gl.BLEND);
  }

  function drawPane(view) {
    const { program: pane, uniforms } = programs.pane;
    into(null);
    gl.useProgram(pane);
    gl.bindVertexArray(emptyVao);
    bindTexture(0, targets.water);
    bindTexture(1, targets.city);
    bindTexture(2, targets.sharp);
    bindTexture(3, targets.mist);
    bindTexture(4, targets.cleared);
    gl.uniform1i(uniforms.water, 0);
    gl.uniform1i(uniforms.city, 1);
    gl.uniform1i(uniforms.sharp, 2);
    gl.uniform1i(uniforms.mist, 3);
    gl.uniform1i(uniforms.cleared, 4);
    gl.uniform2f(uniforms.res, backing.width, backing.height);
    gl.uniform1f(uniforms.lens, (LENS * backing.height) / 0.672);
    // 8-bit targets store heights at 1/24.
    gl.uniform1f(uniforms.heights, floatTargets ? 1 : 24);
    gl.uniform1f(uniforms.day, view.scheme === "light" ? 1 : 0);
    gl.uniform1f(uniforms.range, floatTargets ? 1 : RANGE);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Runs the glass for `seconds`, mist map included. */
  function runGlass(seconds, wetter, view) {
    let left = seconds;
    let steps = 0;
    while (left > 1e-6 && steps < 4 * Math.ceil(seconds / STEP)) {
      const dt = Math.min(STEP, left);
      step(dt, wetter);
      drawMist(dt, view);
      left -= dt;
      steps++;
    }
  }

  /** The same seeded rain from a dry pane, run on until it looks lived-in. */
  function start(view, seconds) {
    resetGlass(1115);
    fadeOwed = 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.cleared.framebuffer);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    runGlass(seconds, 0, view);
    clock = seconds;
    started = true;
  }

  function moods(time) {
    const waiting = swell(time - waitAt, 1600, 3500, 3200);
    const failed = swell(time - failAt, 900, 1800, 3000);
    const bright = Math.max(
      swell(time - mergeAt, 1400, 2400, 4200),
      0.6 * swell(time - doneAt, 1000, 1200, 3200),
    );
    return [waiting, failed, bright];
  }

  function picture(view, mood) {
    drawCities(view, mood);
    drawWater(view);
    drawPane(view);
  }
  let frames = 0;

  ace.scene({
    init(view) {
      gl = view.canvas.getContext("webgl2", {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        // ace's glass and live contrast check read the canvas between frames.
        preserveDrawingBuffer: true,
        powerPreference: "low-power",
      });
      if (!gl) throw new Error("mizzle needs WebGL 2");
      floatTargets = gl.getExtension("EXT_color_buffer_float") !== null;
      // A lost context comes back rebuilt. (Optional calls: a stand-in canvas may not have them.)
      view.canvas.addEventListener?.("webglcontextlost", (event) => event.preventDefault());
      view.canvas.addEventListener?.("webglcontextrestored", () => {
        buildPrograms();
        fit(view);
        started = false;
        stillDrawn = false;
      });
      buildPrograms();
      fit(view);
      // The warm-up runs here, before the first frame is timed: the rain, then one whole
      // picture, waited for, so every shader is compiled before ace starts counting frames.
      if (!view.reduceMotion) start(view, WARM_UP);
      picture(view, [0, 0, 0]);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    },
    resize(view) {
      // The glass keeps its drops; the mist map comes back misted, so trails start again.
      fit(view);
      stillDrawn = false;
      frames = 0;
    },
    motion() {
      stillDrawn = false;
    },
    scheme() {
      stillDrawn = false;
      frames = 0;
    },
    frame(time, view) {
      if (!programs || gl.isContextLost()) return;
      const dt = last < 0 ? 0 : Math.min(Math.max(time - last, 0), 100) / 1000;
      last = time;
      now = time;
      if (view.reduceMotion) {
        // One still frame: the same rain every time, at the moment chosen for it.
        if (stillDrawn) return;
        start(view, STILL_AT);
        picture(view, [0, 0, 0]);
        stillDrawn = true;
        started = false;
        return;
      }
      stillDrawn = false;
      if (!started) start(view, WARM_UP);
      work += ((time < workUntil ? 1 : 0) - work) * (1 - Math.exp(-dt / 2.5));
      clock += dt;
      // Fixed steps, so the rain is the same whatever the frame rate.
      runGlass(dt, work, view);
      // The city moves slowly and out of focus: every other frame is enough for it.
      if (frames++ % 2 === 0) drawCities(view, moods(time));
      drawWater(view);
      drawPane(view);
    },
    signal(name) {
      if (name === "working") workUntil = now + 45_000;
      else if (name === "waiting") waitAt = now;
      else if (name === "failed") failAt = now;
      else if (name === "pr-merged") mergeAt = now;
      else if (name === "done") doneAt = now;
      if (name !== "working") workUntil = Math.min(workUntil, now + 6000);
    },
  });
})();
