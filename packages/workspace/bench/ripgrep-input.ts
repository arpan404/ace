import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { rgSearch } from "../src/rg-search.ts";
import { workspaceRuntime } from "../src/runtime.ts";

// A bounded observation of per-file stdin spawn cost. Windows has no /dev/fd
// reopening contract; retain POSIX batching as the baseline where supported.
const require = createRequire(import.meta.url);
const binary = z.object({ rgPath: z.string() }).parse(require("@vscode/ripgrep")).rgPath;
const native = workspaceRuntime();
const transports = [
  ...(native.platform === "win32" ? [] : [{ name: "fd-batch", runtime: native }]),
  { name: "stdin-per-file", runtime: { ...native, platform: "win32" as const } },
];

async function* input(bytes: Buffer) {
  for (let offset = 0; offset < bytes.length; offset += 8192)
    yield bytes.subarray(offset, offset + 8192);
}

for (const dataset of [
  { name: "64 small files", count: 64, bytes: Buffer.from("needle\n" + "x".repeat(121)) },
  { name: "4 files of 256 KiB", count: 4, bytes: Buffer.from("needle\n" + "x".repeat(262137)) },
]) {
  for (const transport of transports) {
    const samples = [];
    for (let run = 0; run < 3; run++) {
      const start = performance.now();
      const matches = await rgSearch(transport.runtime, binary, {
        files: Array.from({ length: dataset.count }, (_, index) => ({
          path: `${index}.txt`,
          input: input(dataset.bytes),
        })),
        query: "needle",
        regex: false,
        caseSensitive: true,
        limit: 1000,
        bytes: dataset.count * dataset.bytes.length,
      });
      if (matches.length !== dataset.count) throw new Error("Benchmark lost search matches");
      samples.push(performance.now() - start);
    }
    samples.sort((left, right) => left - right);
    console.log(
      JSON.stringify({
        platform: process.platform,
        arch: process.arch,
        dataset: dataset.name,
        transport: transport.name,
        samples: samples.map((value) => Math.round(value)),
        medianMs: Math.round(samples[1] ?? 0),
      }),
    );
  }
}
