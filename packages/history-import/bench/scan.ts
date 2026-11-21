// The TypeScript reader against ace-history (ADR 0206), on generated homes only.
//
//   bun packages/history-import/bench/scan.ts [typescript|rust]...
//
// Per reader: 5,000 small transcripts cold and warm; the scale home (5,352 Codex and 1,027
// Claude transcripts at measured sizes, up to a sparse 1.9 GB rollout) cold and warm; and a
// 300 MB Claude transcript of 200,000 records imported into the archive. Each line reports wall
// time and the reader processes' peak resident memory, sampled every 50 ms.
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ThreadId, WorkspaceId } from "@ace/protocol";
import { openHistory, type HistoryService } from "../src/index.ts";
import { findHistoryBinary } from "../src/rust/reader-binary.ts";
import { scaleFixture } from "./scale-fixture.ts";

const modes = process.argv.slice(2).filter((m) => m === "typescript" || m === "rust");
const binary = findHistoryBinary();
if (modes.includes("rust") && !binary)
  throw new Error("Build native/history first (cargo build --release)");

/** Peak resident memory of this process's children, the readers, while `run` runs. */
async function measured<T>(
  run: () => Promise<T>,
): Promise<{ value: T; ms: number; readerPeakMiB: number }> {
  let peak = 0;
  const sample = () => {
    try {
      const pids = execFileSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" })
        .trim()
        .split("\n");
      const rss = execFileSync("ps", ["-o", "rss=", "-p", pids.join(",")], { encoding: "utf8" })
        .trim()
        .split("\n")
        .reduce((total, line) => total + Number(line.trim() || 0), 0);
      peak = Math.max(peak, rss / 1024);
    } catch {
      // No reader running at this instant.
    }
  };
  const timer = setInterval(sample, 50);
  const started = performance.now();
  try {
    const value = await run();
    sample();
    return {
      value,
      ms: Math.round(performance.now() - started),
      readerPeakMiB: Math.round(peak * 10) / 10,
    };
  } finally {
    clearInterval(timer);
  }
}

async function smallHome(root: string) {
  const project = join(root, "small/projects/p");
  await mkdir(project, { recursive: true });
  for (let batch = 0; batch < 5000; batch += 64)
    await Promise.all(
      Array.from({ length: Math.min(64, 5000 - batch) }, (_, offset) => {
        const id = `session-${batch + offset}`;
        return writeFile(
          join(project, id + ".jsonl"),
          JSON.stringify({
            type: "user",
            sessionId: id,
            cwd: "/workspace",
            message: { role: "user", content: "benchmark prompt" },
          }) + "\n",
        );
      }),
    );
  return [{ id: "small", provider: "claude" as const, homeDir: join(root, "small") }];
}

/** A real (not sparse) transcript: prompts, answers with tool calls, and their results. */
async function largeTranscript(root: string) {
  const project = join(root, "large/projects/p");
  await mkdir(project, { recursive: true });
  const stream = createWriteStream(join(project, "large.jsonl"));
  for (let i = 0; i < 200_000; i++) {
    const uuid = `u${i}`;
    const parentUuid = i ? `u${i - 1}` : null;
    const record =
      i % 4 === 0
        ? {
            type: "user",
            uuid,
            parentUuid,
            sessionId: "large",
            cwd: "/large",
            message: { role: "user", content: "q".repeat(1200) },
          }
        : i % 4 === 1
          ? {
              type: "assistant",
              uuid,
              parentUuid,
              sessionId: "large",
              message: {
                role: "assistant",
                content: [
                  { type: "text", text: "a".repeat(600) },
                  { type: "tool_use", id: `t${i}`, name: "Bash", input: { command: "ls" } },
                ],
              },
            }
          : i % 4 === 2
            ? {
                type: "user",
                uuid,
                parentUuid,
                sessionId: "large",
                message: {
                  role: "user",
                  content: [
                    { type: "tool_result", tool_use_id: `t${i - 1}`, content: "r".repeat(2000) },
                  ],
                },
              }
            : {
                type: "assistant",
                uuid,
                parentUuid,
                sessionId: "large",
                message: {
                  role: "assistant",
                  content: [{ type: "thinking", thinking: "t".repeat(800) }],
                },
              };
    if (!stream.write(JSON.stringify(record) + "\n")) await once(stream, "drain");
  }
  stream.end();
  await once(stream, "finish");
  return [{ id: "large", provider: "claude" as const, homeDir: join(root, "large") }];
}

async function open(
  root: string,
  mode: string,
  label: string,
  instances: Parameters<typeof openHistory>[0]["instances"],
) {
  return openHistory(
    {
      indexPath: join(root, `index-${mode}-${label}/index.sqlite`),
      instances,
      snapshot: { minFreeBytes: 0, minFreeRatio: 0 },
    },
    undefined,
    { readerBinary: mode === "rust" ? (binary ?? null) : null },
  );
}

async function scans(
  root: string,
  mode: string,
  label: string,
  instances: Parameters<typeof openHistory>[0]["instances"],
) {
  const service = await open(root, mode, label, instances);
  try {
    for (const phase of ["cold", "warm"]) {
      const { value, ms, readerPeakMiB } = await measured(() => service.scan());
      console.log(
        JSON.stringify({
          mode,
          benchmark: `${label}-${phase}`,
          ms,
          readerPeakMiB,
          files: value.files,
          reads: value.reads,
          bytes: value.bytes,
        }),
      );
    }
  } finally {
    await service.close();
  }
}

async function largeImport(
  root: string,
  mode: string,
  instances: Parameters<typeof openHistory>[0]["instances"],
) {
  let service: HistoryService | undefined;
  try {
    service = await open(root, mode, "large", instances);
    const opened = service;
    await opened.scan();
    const source = (await opened.list({ type: "history.list", cwd: "/large" })).sessions[0];
    if (!source) throw new Error("Missing large session");
    const { value, ms, readerPeakMiB } = await measured(() =>
      opened.importSession({
        sourceId: source.id,
        threadId: ThreadId.parse(`bench-${mode}`),
        workspaceId: WorkspaceId.parse("bench"),
        agentId: "bench",
        at: 0,
      }),
    );
    console.log(
      JSON.stringify({ mode, benchmark: "300mb-200k-record-import", ms, readerPeakMiB, ...value }),
    );
  } finally {
    await service?.close();
  }
}

const root = await mkdtemp(join(tmpdir(), "ace-history-bench-"));
try {
  const small = await smallHome(root);
  const scale = await scaleFixture(join(root, "scale"), 0);
  const scaleHomes = scale.instances.filter((i) => i.provider !== "opencode");
  const large = await largeTranscript(root);
  for (const mode of modes.length ? modes : ["typescript", "rust"]) {
    await scans(root, mode, "5000-files", small);
    await scans(root, mode, "scale-home", scaleHomes);
    await largeImport(root, mode, large);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
