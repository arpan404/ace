/*
 * Suit scenes for the scene allowlist's tests (ADR 0173 §8): each `blocked` sample reaches a
 * capability a scene may not have by a spelling a name match misses (built property names,
 * reflection, aliases), or loads from outside the Suit through its CSS or ornaments. The `benign`
 * samples only draw. Inert data: nothing here is run, and every host is under `.invalid`.
 */

export interface SceneSample {
  id: string;
  files: Record<string, string>;
}

const suitJson = JSON.stringify({ format: 1, id: "sample", name: "Sample", version: "1" });

const scene = (id: string, code: string): SceneSample => ({
  id,
  files: { "suit.json": suitJson, "scene.js": code },
});

export const blockedScenes: readonly SceneSample[] = [
  scene(
    "computed-member-fetch",
    `ace.scene({ frame(time, view) { globalThis["fe" + "tch"]("/p?w=" + view.width); } });\n`,
  ),
  scene(
    "constructor-escape",
    `ace.scene({ init() { (() => {}).constructor("return this")(); }, frame() {} });\n`,
  ),
  scene(
    "function-from-string",
    `const run = Function("return this.location");\nace.scene({ frame() { run(); } });\n`,
  ),
  scene(
    "dynamic-import-remote",
    "ace.scene({ init() { import /* later */ (`ht${'tps'}://cdn.example.invalid/m.js`); }, frame() {} });\n",
  ),
  scene(
    "string-timer",
    `const code = "draw()";\nace.scene({ init() { setTimeout(code, 10); }, frame() {} });\n`,
  ),
  scene(
    "webassembly",
    `const W = self["Web" + "Assembly"];\nace.scene({ init() { W.compile(new Uint8Array(8)); }, frame() {} });\n`,
  ),
  scene(
    "built-constructor-name",
    `const k = ["con", "struc", "tor"].join("");\nace.scene({ init(view) { view.canvas[k][k]("x")(); }, frame() {} });\n`,
  ),
  scene("global-alias", `const w = window;\nace.scene({ frame() { w.navigator.userAgent; } });\n`),
  scene("unreadable", `ace.scene({ frame() { ctx.fillRect(0, 0, ) ) } });\n`),
  {
    id: "css-remote-url",
    files: {
      "suit.json": suitJson,
      "suit.css": `@font-face {\n  font-family: Mark;\n  src: url("https://fonts.example.invalid/mark.woff2");\n}\n`,
    },
  },
  {
    id: "css-escaped-remote-url",
    files: {
      "suit.json": suitJson,
      "suit.css": `:root { background: url(\\68ttps://img.example.invalid/a.png); }\n`,
    },
  },
  {
    id: "css-import",
    files: { "suit.json": suitJson, "suit.css": `@import "theme-extra.css";\n` },
  },
  {
    id: "svg-script",
    files: {
      "suit.json": suitJson,
      "assets/mark.svg": `<svg xmlns="http://www.w3.org/2000/svg"><script>/* nothing */</script></svg>\n`,
    },
  },
  {
    id: "svg-external-ref",
    files: {
      "suit.json": suitJson,
      "assets/mark.svg": `<svg xmlns="http://www.w3.org/2000/svg"><image href="https://img.example.invalid/x.png"/></svg>\n`,
    },
  },
];

export const benignScenes: readonly SceneSample[] = [
  scene(
    "canvas-animation",
    `let ctx;
const dots = [];
function tick(time) {
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);
  for (const [index, dot] of dots.entries()) {
    const x = (dot.x + Math.sin(time / 900 + index) * 0.02) * width;
    ctx.fillStyle = \`rgba(120, 160, 220, \${0.2 + dot.z * 0.3})\`;
    ctx.fillRect(x, dot.y * height, 2, 2);
  }
  requestAnimationFrame(tick);
}
ace.scene({
  init(view) {
    ctx = view.canvas.getContext("2d");
    for (let i = 0; i < 64; i += 1) dots.push({ x: Math.random(), y: Math.random(), z: Math.random() });
    requestAnimationFrame(tick);
  },
  frame() {},
});
`,
  ),
  scene(
    "performance-and-params",
    `const looks = { dark: "#07080c", light: "#eef0f4" };
let ctx;
let started = 0;
ace.scene({
  init(view) {
    ctx = view.canvas.getContext("2d", { alpha: false });
    started = performance.now();
  },
  frame(time, { width, height, pixelRatio, scheme, reduceMotion }) {
    const elapsed = reduceMotion ? 0 : performance.now() - started;
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    ctx.fillStyle = looks[scheme];
    ctx.fillRect(0, 0, width, height);
    const glow = ctx.createRadialGradient(width / 2, height, 0, width / 2, height, height);
    glow.addColorStop(0, \`hsla(\${(elapsed / 100) % 360}, 60%, 50%, 0.2)\`);
    glow.addColorStop(1, "transparent");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);
  },
  signal(name) {
    if (name === "done") ace.finish();
  },
});
`,
  ),
  {
    id: "local-font-css",
    files: {
      "suit.json": suitJson,
      "suit.css": `/* Mark, bundled. */\n@font-face {\n  font-family: Mark;\n  src: url("assets/fonts/Mark.woff2") format("woff2");\n}\n`,
    },
  },
];
