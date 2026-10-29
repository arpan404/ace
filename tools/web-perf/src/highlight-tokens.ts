import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Tokenizer bake-off: Prism grammars (the previous highlighting engine) against the markit
 * Wasm tokenizer (the new one). Same inputs, same process, back to back. Report-only:
 * node src/highlight-tokens.ts [--runs N].
 *
 * Runs in either tree. The markit section is skipped when packages/markit is absent, so the
 * same command measures the previous engine on main and both engines on a markit branch.
 * Inputs are real repo sources: salted per run so no session cache can answer, mirroring how
 * the app highlights each file once. Markit's default tokenizer bails to plain past its run
 * budget (large files); the app falls back to Prism there (runMarkitHighlight).
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const markitWeb = join(root, "packages", "markit", "web");
const runs = Number(process.env.HIGHLIGHT_RUNS ?? 10);

interface Token {
  text: string;
  light?: string | undefined;
  dark?: string | undefined;
}

/** Split highlighted tokens at newlines; mirrors apps/web markdown code-lines.ts. */
function splitLines(tokens: readonly Token[]): Token[][] {
  const lines: Token[][] = [[]];
  for (const token of tokens) {
    const parts = token.text.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) lines.at(-1)?.push({ ...token, text: part });
    });
  }
  return lines;
}

async function loadFixture(relativePath: string, repeats: number, salt: string): Promise<string> {
  const base = await readFile(join(root, relativePath), "utf8");
  if (repeats === 1) return base;
  const parts = [`// fixture ${salt}\n`];
  for (let copy = 0; copy < repeats; copy++) parts.push(`// copy ${copy} ${salt}\n`, base);
  return parts.join("");
}

const median = (values: number[]): number =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const p95 = (values: number[]): number =>
  values.toSorted((a, b) => a - b)[Math.min(values.length - 1, Math.floor(0.95 * values.length))] ??
  0;

function report(name: string, ms: number[], tokens: number): void {
  process.stdout.write(
    `${name}: median ${median(ms).toFixed(1)} ms, p95 ${p95(ms).toFixed(1)} ms over ${ms.length} runs (${tokens} token runs)\n`,
  );
}

async function timePrism(label: string, relativePath: string, repeats: number): Promise<void> {
  const started = performance.now();
  // Relative import: @ace/ui-core is not a dependency of this tool.
  const { sourceHighlight } = await import("../../../packages/ui-core/src/source-highlight.ts");
  const loadMs = performance.now() - started;
  const ms: number[] = [];
  let tokens = 0;
  for (let run = 0; run < runs; run++) {
    const source = await loadFixture(relativePath, repeats, `prism-${run}`);
    const begin = performance.now();
    const lines = await sourceHighlight(source, "typescript");
    const weighed = lines?.reduce((sum, line) => sum + line.length, 0) ?? 0;
    ms.push(performance.now() - begin);
    tokens += weighed;
  }
  process.stdout.write(`prism ${label} (grammar load ${loadMs.toFixed(0)} ms once): `);
  report("tokenize+split", ms, tokens);
}

async function timeMarkit(label: string, relativePath: string, repeats: number): Promise<boolean> {
  const wasm = join(markitWeb, "pkg", "markit_wasm_bg.wasm");
  const glue = join(markitWeb, "pkg", "markit_wasm.js");
  const unpack = join(markitWeb, "highlight.js");
  if (!existsSync(wasm) || !existsSync(glue) || !existsSync(unpack)) {
    process.stdout.write(`markit ${label}: packages/markit web build absent, skipping\n`);
    return false;
  }
  const started = performance.now();
  const wasmModule = (await import(glue)) as {
    default: (input: Uint8Array) => Promise<unknown>;
    highlightCodePacked: (source: string, language: string) => Uint32Array;
  };
  await wasmModule.default(await readFile(wasm));
  const { unpackHighlight } = (await import(unpack)) as {
    unpackHighlight: (
      source: string,
      words: Uint32Array,
    ) => { plain: boolean; tokens: Array<{ text: string; light: string; dark: string }> };
  };
  const loadMs = performance.now() - started;
  const ms: number[] = [];
  let tokens = 0;
  let plain = 0;
  for (let run = 0; run < runs; run++) {
    const source = await loadFixture(relativePath, repeats, `markit-${run}`);
    const begin = performance.now();
    const packed = wasmModule.highlightCodePacked(source, "typescript");
    const highlighted = unpackHighlight(source, packed);
    const lines = splitLines(
      highlighted.tokens.map((token) => ({ kind: "plain" as const, ...token })),
    );
    ms.push(performance.now() - begin);
    tokens += highlighted.tokens.length;
    if (highlighted.plain || lines.length === 0) plain++;
  }
  process.stdout.write(`markit ${label} (wasm init ${loadMs.toFixed(0)} ms once): `);
  report("tokenize+unpack+split", ms, tokens);
  if (plain > 0) process.stdout.write(`markit ${label}: plain fallback on ${plain}/${runs} runs\n`);
  return true;
}

const cases = [
  { label: "small ~2KB", path: "packages/ui-core/src/lru.ts", repeats: 1 },
  { label: "medium ~60KB", path: "packages/fake-daemon/src/daemon.ts", repeats: 1 },
  { label: "large ~490KB", path: "packages/fake-daemon/src/daemon.ts", repeats: 8 },
] as const;

let ok = false;
for (const { label, path, repeats } of cases) {
  process.stdout.write(`--- ${label} (${path}${repeats > 1 ? ` x${repeats}` : ""}) ---\n`);
  ok =
    (await timePrism(label, path, repeats).then(
      () => true,
      (error: unknown) => {
        process.stdout.write(
          `prism ${label}: failed (${error instanceof Error ? error.message : error})\n`,
        );
        return false;
      },
    )) || ok;
  ok =
    (await timeMarkit(label, path, repeats).catch((error: unknown) => {
      process.stdout.write(
        `markit ${label}: failed (${error instanceof Error ? error.message : error})\n`,
      );
      return false;
    })) || ok;
}
if (!ok) process.exit(1);
