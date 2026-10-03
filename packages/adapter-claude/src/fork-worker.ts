import { forkSession } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
// Filesystem helpers read process-global CLAUDE_CONFIG_DIR. This process owns one account home.
const source = z.uuid().parse(process.argv[2]);
try {
  const result = z.object({ sessionId: z.uuid() }).parse(await forkSession(source));
  if (result.sessionId === source) throw new Error("Claude fork reused source identity");
  console.log(JSON.stringify(result));
} catch {
  // SDK error messages can include home paths and transcript content.
  process.stderr.write("Claude idle history fork failed\n");
  process.exitCode = 1;
}
