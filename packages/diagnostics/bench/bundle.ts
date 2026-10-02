import { createWriteStream } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { performance } from "node:perf_hooks";
import { createRedactor } from "@ace/redaction";
import { writeSupportBundle } from "../src/index.ts";
const root = await mkdtemp(join(tmpdir(), "ace-bundle-bench-"));
try {
  const logs = join(root, "logs");
  await mkdir(logs);
  const line =
    JSON.stringify({ message: "ghp_abcdefghijklmnopqrstuvwxyz123456", detail: "x".repeat(900) }) +
    "\n";
  const count = 16000,
    bytes = Buffer.byteLength(line) * count;
  await pipeline(
    Readable.from(
      (async function* () {
        for (let n = 0; n < count; n++) yield line;
      })(),
    ),
    createWriteStream(join(logs, "ace.jsonl")),
  );
  const began = performance.now();
  await writeSupportBundle({
    logsDirectory: logs,
    temporaryRoot: root,
    output: createWriteStream(join(root, "support.tar.gz")),
    report: { at: 0, checks: [] },
    versions: {},
    settings: {},
    redact: createRedactor({}),
  });
  const seconds = (performance.now() - began) / 1000;
  console.log(
    JSON.stringify(
      {
        inputMiB: bytes / 1024 ** 2,
        inputMiBPerSecond: bytes / 1024 ** 2 / seconds,
        peakRssMiB: process.resourceUsage().maxRSS / 1024,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
