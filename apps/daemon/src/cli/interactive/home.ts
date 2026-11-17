import { overview } from "../help/pages.ts";
import { useColor } from "../input-mode.ts";
import { emit } from "../io.ts";
import type { CommandContext } from "../run/context.ts";
import { paint } from "../tui/paint.ts";
import { openTerminal } from "../tui/terminal.ts";
import { readKeptRows } from "./home-cache.ts";
import { homeStart } from "./home-state.ts";
import { homeView } from "./home-view.ts";

/**
 * The interactive home (ADR 0176 §9): bare `ace` on a terminal. The dispatcher only calls this
 * when `args.interactive` is true. Its first frame draws from the small terminal and view
 * modules and the rows the last run kept, before the client, the config and the schemas load,
 * so the home answers Enter at once (the 150 ms budget). Kept rows say "Syncing" until the
 * live list replaces them.
 */
export async function interactiveHome(context: CommandContext): Promise<void> {
  const terminal = openTerminal({ input: process.stdin, output: process.stdout, process, fd: 1 });
  const ink = paint(
    useColor({ flags: context.args.flags, env: context.env, stdinTTY: true, stdoutTTY: true }),
  );
  const dataDir = context.dataDir();
  // A remote's threads aren't the ones this home kept.
  const kept = context.args.flags.remote ? [] : readKeptRows(dataDir);
  terminal.draw({
    lines: homeView(
      homeStart,
      { rows: kept, loading: true, requests: 0, tree: undefined, connection: "Connecting…" },
      terminal.columns - 1,
      terminal.rows - 1,
      ink,
    ),
  });
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
    dataDir,
    kept,
    env: context.env,
    table: context.table,
    startDaemon: false,
    terminal,
  });
}
