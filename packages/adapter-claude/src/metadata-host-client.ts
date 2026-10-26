import { fileURLToPath } from "node:url";
import { z } from "zod";
import { registerGroup, spawnSupervised, stopRetainedGroup } from "@ace/provider-kit/process";
import { askClaude, type MetadataQueryInput } from "./metadata-query.ts";
import { metadataQuestions, type MetadataQuestion } from "./metadata-questions.ts";

/** The helper names the CLI it started before it answers. */
const Started = z.object({ cli: z.number().int().positive() });
const Reply = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({ ok: z.literal(false) }),
]);

/**
 * One metadata question about a Claude login. The SDK (about 8 MB of heap once loaded) is
 * loaded in a short-lived helper process, not the daemon, unless the caller injected its own
 * `spawn`, which cannot cross into another process. The reply is parsed here, at the boundary.
 */
export async function askClaudeMetadata(
  input: MetadataQueryInput,
  question: MetadataQuestion,
): Promise<unknown> {
  const { what, ask } = metadataQuestions[question];
  if (input.spawn) return askClaude(input, what, ask);
  input.signal.throwIfAborted();
  // Windows: the host's tree (it and the CLI it starts) is recorded, then ended and awaited.
  const treeStop =
    (input.platform ?? process.platform) === "win32"
      ? await import("@ace/provider-kit/tree-stop")
      : undefined;
  let hostTree: import("@ace/provider-kit/tree-stop").RecordedTree | undefined;
  let eofStop: Promise<unknown> | undefined;
  const host = spawnSupervised({
    command: process.execPath,
    args: [
      fileURLToPath(new URL("./metadata-host.ts", import.meta.url)),
      question,
      JSON.stringify({ executable: input.executable, args: input.args, cwd: input.cwd }),
    ],
    cwd: input.cwd,
    env: input.env,
    name: "claude-metadata",
    maxLineBytes: 8 * 1024 * 1024,
    maxOutputBytes: 8 * 1024 * 1024,
  });
  let reply: z.infer<typeof Reply> | undefined;
  let cli: number | undefined;
  host.stdout.on("line", (line) => {
    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch {
      return; // Not a frame; a missing reply fails the question below.
    }
    const started = Started.safeParse(data).data;
    if (started && cli === undefined) {
      // The CLI has its own process group. Owning it here (journaled, stopped on this
      // process's exit) means a helper killed outright cannot leave it running.
      cli = started.cli;
      const pid = cli;
      registerGroup(pid, (graceMs) => stopRetainedGroup(pid, graceMs), { name: "claude" });
      if (treeStop && host.pid !== undefined) hostTree = treeStop.recordTree(host.pid);
      return;
    }
    reply ??= Reply.safeParse(data).data;
  });
  // Windows never delivers SIGTERM to the host: its stdin closing is the graceful stop there,
  // ahead of the tree stop below, which still forces it after the grace.
  const windows = (input.platform ?? process.platform) === "win32";
  const closeInput = () => {
    eofStop ??= treeStop?.stopTreeAfterEof(host, 2000);
  };
  if (windows) input.signal.addEventListener("abort", closeInput, { once: true });
  // The host exits on SIGTERM and takes its CLI with it; the grace lets it do so.
  const stop = () => void host.stop({ graceMs: 2000 });
  input.signal.addEventListener("abort", stop, { once: true });
  try {
    await host.exited;
    input.signal.throwIfAborted();
    if (!reply?.ok) throw new Error(`Claude ${what} failed`);
    return reply.value;
  } finally {
    if (windows) {
      input.signal.removeEventListener("abort", closeInput);
      await eofStop;
      await hostTree?.end();
    }
    input.signal.removeEventListener("abort", stop);
    await host.stop({ graceMs: 2000 });
    // Normally the helper already stopped it; this ends a CLI the helper left behind.
    if (cli !== undefined) await stopRetainedGroup(cli, 0);
  }
}
