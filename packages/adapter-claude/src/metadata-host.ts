import { routeConsoleToStderr } from "@ace/provider-kit/console-guard";

/*
 * Runs one initialization-only query in its own process, so the daemon never loads the Claude
 * SDK for metadata alone. The CLI it starts is owned by this process: a stop (SIGTERM) or the
 * daemon going away (stdin closes) exits it, and provider-kit stops owned process groups on exit.
 */
// Stdout carries the helper's frames, and Bun's console writes there directly; console goes to
// stderr before any dependency loads, since static imports would evaluate ahead of this call.
routeConsoleToStderr();
const { z } = await import("zod");
const { askClaude } = await import("./metadata-query.ts");
const { metadataQuestions } = await import("./metadata-questions.ts");
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
    {
      ...target,
      env: process.env,
      signal: controller.signal,
      // The daemon owns this CLI's group too, so it ends even if this helper is killed outright.
      onCliProcess: (pid) => process.stdout.write(`${JSON.stringify({ cli: pid })}\n`),
    },
    what,
    ask,
  );
  process.stdout.write(`${JSON.stringify({ ok: true, value: value ?? null })}\n`);
} catch {
  // SDK and CLI errors can carry paths and account details; the daemon reports fixed words.
  process.stdout.write(`${JSON.stringify({ ok: false })}\n`);
}
process.exit(0);
