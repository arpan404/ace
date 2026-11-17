import { overview } from "../help/pages.ts";
import { useColor } from "../input-mode.ts";
import { emit } from "../io.ts";
import type { CommandContext } from "../run/context.ts";
import { paint } from "../tui/paint.ts";
import { openTerminal } from "../tui/terminal.ts";

/**
 * The interactive home (ADR 0176 §9): bare `ace` on a terminal. The dispatcher only calls this
 * when `args.interactive` is true. Its first line draws from the small terminal module before
 * the client and the views load, so the home answers Enter at once (the 150 ms budget).
 */
export async function interactiveHome(context: CommandContext): Promise<void> {
  const terminal = openTerminal({ input: process.stdin, output: process.stdout, process, fd: 1 });
  const ink = paint(
    useColor({ flags: context.args.flags, env: context.env, stdinTTY: true, stdoutTTY: true }),
  );
  terminal.draw({ lines: [`ace  ${ink.dim("Connecting…")}`] });
  let app: typeof import("./app.ts");
  try {
    app = await import("./app.ts");
  } catch {
    // A broken install still lands the person on the way out (ADR 0176 §13).
    terminal.close();
    process.stderr.write("Something in ace is broken. Run ace doctor or ace triage.\n");
    return emit(context.args, overview(context.table));
  }
  await app.runApp({
    args: context.args,
    dataDir: context.config().dataDir,
    env: context.env,
    table: context.table,
    startDaemon: false,
    terminal,
  });
}
