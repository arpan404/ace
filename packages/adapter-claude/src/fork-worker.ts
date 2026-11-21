import { silenceConsole } from "@ace/provider-kit/console-guard";

// Stdout carries one result line, and the parent fails the fork on any other line or past a small
// output budget. Bun's console writes to fds 1 and 2 directly, and the SDK's logs can carry home
// paths and transcript content, so console is silenced before any dependency is imported.
silenceConsole();
const { z } = await import("zod");
const { forkSession } = await import("@anthropic-ai/claude-agent-sdk");
// Filesystem helpers read process-global CLAUDE_CONFIG_DIR. This process owns one account home.
const source = z.uuid().parse(process.argv[2]);
try {
  const result = z.object({ sessionId: z.uuid() }).parse(await forkSession(source));
  if (result.sessionId === source) throw new Error("Claude fork reused source identity");
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  // SDK error messages can include home paths and transcript content.
  process.stderr.write("Claude idle history fork failed\n");
  process.exitCode = 1;
}
