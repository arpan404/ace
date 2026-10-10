import assert from "node:assert/strict";
import { contentHash } from "../../../packages/ui-core/src/content-hash.ts";
import { sourceHighlight } from "../src/components/markdown/source-highlight.ts";
import { codeLines } from "../src/components/markdown/code-lines.ts";

// Isolate CPU stages without attributing Node timings to browser presentation or worker transport.
// Run separately from budget checks: node --expose-gc apps/web/scripts/source-stages.ts
const line = "export function greet(name: string) { return `Hello ${name}`; } // greeting\n";
async function median(work: () => unknown | Promise<unknown>, count: number): Promise<number> {
  const samples: number[] = [];
  for (let index = 0; index < count; index++) {
    globalThis.gc?.();
    const start = performance.now();
    await work();
    samples.push(performance.now() - start);
  }
  samples.sort((left, right) => left - right);
  return Number(samples[Math.floor(samples.length / 2)]?.toFixed(2));
}

await sourceHighlight(line, "typescript");
for (const budget of [128 * 1024, 1024 * 1024]) {
  const source = line.repeat(Math.floor(budget / line.length));
  contentHash(source);
  const tokens = await sourceHighlight(source, "typescript");
  assert(tokens);
  assert.equal(tokens.map((row) => row.map((token) => token.text).join("")).join("\n"), source);
  const clone = structuredClone(tokens);
  assert.deepEqual(clone, tokens);
  const reply = await codeLines(source, "typescript");
  assert.deepEqual(structuredClone(reply), reply);
  console.log({
    sourceBytes: Buffer.byteLength(source),
    tokenCount: tokens.reduce((count, row) => count + row.length, 0),
    tokenJsonBytes: Buffer.byteLength(JSON.stringify(tokens)),
    hashMs: await median(() => contentHash(source), 5),
    grammarAndTokensMs: await median(() => sourceHighlight(source, "typescript"), 3),
    tokenCloneMs: await median(() => structuredClone(tokens), 5),
    workerReplyJsonBytes: Buffer.byteLength(JSON.stringify(reply)),
    workerReplyCloneMs: await median(() => structuredClone(reply), 5),
    plainReply: "plain" in reply,
  });
}
