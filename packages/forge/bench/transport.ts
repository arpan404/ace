// Where one host API request's local cost goes, without a network or the person's credentials:
// the CommandRunner's spawn, pipe and capture (measured with /bin/cat echoing a canned HTTP reply,
// so the child itself costs almost nothing), and JSON.parse of the same body. Pair it with
// `bench/status.ts` (decode, revisions, Zod) and a `gh --version` loop for the CLI's own start.
//
//   node packages/forge/bench/transport.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createCommandRunner } from "../src/index.ts";

const cwd = await mkdtemp(join(tmpdir(), "ace-forge-transport-"));
const runner = createCommandRunner({ cwd });
const signal = new AbortController().signal;
const comment = (id: number) => ({
  id,
  node_id: `PRRC_${id}`,
  body: "Please fix the error handling in this branch before merging",
  user: { login: "alice", id: 1, type: "User" },
  updated_at: "2026-11-23T00:00:00Z",
  created_at: "2026-11-23T00:00:00Z",
  path: "src/index.ts",
  line: id,
  commit_id: "a".repeat(40),
  html_url: `https://github.com/octo/ace/pull/7#discussion_r${id}`,
});
try {
  for (const records of [1, 100, 1_000]) {
    const body = JSON.stringify(Array.from({ length: records }, (_, index) => comment(index + 1)));
    const reply = `HTTP/2.0 200 OK\r\nETag: "e"\r\nContent-Type: application/json\r\n\r\n${body}`;
    const samples = 50;
    let spawnMs = 0;
    let parseMs = 0;
    const cpu = process.cpuUsage();
    for (let index = 0; index < samples; index++) {
      const started = performance.now();
      const result = await runner({
        command: "/bin/cat",
        args: [],
        input: reply,
        signal,
        mode: "json",
      });
      spawnMs += performance.now() - started;
      const parsing = performance.now();
      JSON.parse(result.stdout.slice(result.stdout.indexOf("\r\n\r\n") + 4));
      parseMs += performance.now() - parsing;
    }
    const used = process.cpuUsage(cpu);
    console.log(
      JSON.stringify({
        records,
        bytes: Buffer.byteLength(reply),
        runnerMsPerRequest: +(spawnMs / samples).toFixed(2),
        jsonParseMsPerRequest: +(parseMs / samples).toFixed(3),
        daemonCpuMsPerRequest: +((used.user + used.system) / 1000 / samples).toFixed(2),
      }),
    );
  }
} finally {
  await rm(cwd, { recursive: true, force: true });
}
