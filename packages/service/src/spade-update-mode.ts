import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * The desktop app restarts into its update before Spade's turn comes (ADR 0123), so the mode
 * the person chose (`now` for a confirmed Restart, `idle` when the update waited for agents)
 * waits in this file for the Spade swap after the next launch. Plain files only: the app's
 * main process imports this.
 */
export const spadeUpdateModeFile = "spade-update-mode.json";
const PendingMode = z.object({ mode: z.enum(["idle", "now"]) });

export async function rememberSpadeUpdateMode(home: string, mode: "idle" | "now"): Promise<void> {
  const file = join(home, spadeUpdateModeFile);
  await writeFile(file + ".next", JSON.stringify({ mode }), { mode: 0o600 });
  await rename(file + ".next", file);
}

/** The remembered mode, removed as it is read; `idle` when none was left. */
export async function takeSpadeUpdateMode(home: string): Promise<"idle" | "now"> {
  const file = join(home, spadeUpdateModeFile);
  const text = await readFile(file, "utf8").catch(() => undefined);
  await rm(file, { force: true });
  if (text === undefined) return "idle";
  try {
    return PendingMode.parse(JSON.parse(text)).mode;
  } catch {
    return "idle";
  }
}
