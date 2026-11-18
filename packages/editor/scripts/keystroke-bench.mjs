import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EditorDocument, init } from "../src/index.ts";

/*
 * What one keystroke costs through the wrapper, on the document size the plan names:
 * 200,000 lines, 1,000 single-character inserts, each paired with the `lines` call a view makes
 * for the visible range. Run with `node scripts/keystroke-bench.mjs` after `bun run build`.
 */

const LINES = 200_000;
const KEYSTROKES = 1_000;
const CARET_LINE = 100_000;
const VIEWPORT = 60;

const wasmFile = new URL("../pkg/editor_wasm_bg.wasm", import.meta.url);
await init({ wasm: readFileSync(fileURLToPath(wasmFile)) });

const source = "  const value = 0;\n".repeat(LINES);
const startedLoad = performance.now();
const document = new EditorDocument(source);
const loadMs = performance.now() - startedLoad;

document.setSelections([
  {
    anchor: { line: CARET_LINE, column: 0 },
    head: { line: CARET_LINE, column: 0 },
  },
]);

const insert = [];
const view = [];
let visible = [];
for (let index = 0; index < KEYSTROKES; index += 1) {
  const before = performance.now();
  document.insertText("x");
  const afterInsert = performance.now();
  visible = document.lines(CARET_LINE - 10, CARET_LINE - 10 + VIEWPORT);
  const afterView = performance.now();
  insert.push(afterInsert - before);
  view.push(afterView - before);
}
if (visible.length !== VIEWPORT) {
  throw new Error(`the view read ${visible.length} lines instead of ${VIEWPORT}`);
}

report("keystroke (insert only)", insert);
report("keystroke (insert + visible lines)", view);
process.stdout.write(
  `load: ${loadMs.toFixed(1)} ms for ${LINES.toLocaleString("en-US")} lines, ` +
    `${document.lenLines().toLocaleString("en-US")} lines in the document\n`,
);

function report(label, samples) {
  const sorted = samples.toSorted((a, b) => a - b);
  const total = samples.reduce((sum, value) => sum + value, 0);
  process.stdout.write(
    `${label}: p50 ${percentile(sorted, 50)} ms, p95 ${percentile(sorted, 95)} ms, ` +
      `mean ${(total / samples.length).toFixed(4)} ms, total ${total.toFixed(1)} ms\n`,
  );
}

function percentile(sorted, fraction) {
  const index = Math.min(sorted.length - 1, Math.floor((fraction / 100) * sorted.length));
  return sorted[index].toFixed(4);
}
