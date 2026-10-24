import { fileURLToPath } from "node:url";
import { z } from "zod";
import { spawnSupervised } from "@ace/provider-kit/process";
import { askClaude, type MetadataQueryInput } from "./metadata-query.ts";
import { metadataQuestions, type MetadataQuestion } from "./metadata-questions.ts";

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
  host.stdout.on("line", (line) => {
    try {
      reply ??= Reply.safeParse(JSON.parse(line)).data;
    } catch {
      // Not a reply; a missing reply fails the question below.
    }
  });
  // The host exits on SIGTERM and takes its CLI with it; the grace lets it do so.
  const stop = () => void host.stop({ graceMs: 2000 });
  input.signal.addEventListener("abort", stop, { once: true });
  try {
    await host.exited;
    input.signal.throwIfAborted();
    if (!reply?.ok) throw new Error(`Claude ${what} failed`);
    return reply.value;
  } finally {
    input.signal.removeEventListener("abort", stop);
    await host.stop({ graceMs: 2000 });
  }
}
