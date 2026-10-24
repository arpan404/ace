import { z } from "zod";
import { askClaude } from "./metadata-query.ts";
import { metadataQuestions } from "./metadata-questions.ts";

/*
 * Runs one initialization-only query in its own process, so the daemon never loads the Claude
 * SDK for metadata alone. The CLI it starts is owned by this process: a stop (SIGTERM) or the
 * daemon going away (stdin closes) exits it, and provider-kit stops owned process groups on exit.
 */
const question = z.enum(["models", "usage"]).parse(process.argv[2]);
const target = z
  .object({ executable: z.string().min(1), args: z.array(z.string()), cwd: z.string().min(1) })
  .parse(JSON.parse(process.argv[3] ?? ""));
const controller = new AbortController();
const leave = () => {
  controller.abort();
  process.exit(143);
};
process.on("SIGTERM", leave);
process.stdin.on("end", leave);
process.stdin.resume();
const { what, ask } = metadataQuestions[question];
try {
  const value = await askClaude(
    { ...target, env: process.env, signal: controller.signal },
    what,
    ask,
  );
  process.stdout.write(`${JSON.stringify({ ok: true, value: value ?? null })}\n`);
} catch {
  // SDK and CLI errors can carry paths and account details; the daemon reports fixed words.
  process.stdout.write(`${JSON.stringify({ ok: false })}\n`);
}
process.exit(0);
