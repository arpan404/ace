import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { ScreenClient, ScreenClientError } from "@ace/client/screen";
import type { ScreenPermissions } from "@ace/protocol";
import type { DoctorContext } from "./feature.ts";

/**
 * What the running daemon says about computer use. macOS grants belong to Ace Screen Helper,
 * and only the helper can read them, so they are known only while ace runs it.
 */
export type ScreenFacts =
  | { kind: "known"; enabled: boolean; permissions: ScreenPermissions }
  /** The daemon runs without a screen helper (started outside the desktop app). */
  | { kind: "unconfigured" }
  | { kind: "failed"; message: string };

export type ComputerUsePorts = {
  /** Undefined while the daemon is stopped or doesn't answer. */
  screen(context: DoctorContext): Promise<ScreenFacts | undefined>;
  /** The helper executable ace would run, when one is installed. */
  helper(context: DoctorContext): Promise<string | undefined>;
};

export const computerUsePorts: ComputerUsePorts = {
  screen: (context) =>
    context.daemonState === "running"
      ? context.daemon(async (client, signal) => {
          const screen = new ScreenClient(client);
          try {
            // `status` reports grants as off while computer use is off, so ask for them directly.
            const { enabled } = await screen.status({ signal });
            return { kind: "known", enabled, permissions: await screen.permissions({ signal }) };
          } catch (error) {
            if (error instanceof ScreenClientError && error.errorCode === "screen_disabled")
              return { kind: "unconfigured" };
            return {
              kind: "failed",
              message: error instanceof Error ? error.message : "Screen request failed",
            };
          }
        })
      : Promise.resolve(undefined),
  helper: (context) => installedHelper(context.config.dataDir, context.config.screenHelper),
};

const executable = join("AceScreenHelper.app", "Contents", "MacOS", "ace-screen-helper");

/**
 * The helper ace runs: the one named by ACE_SCREEN_HELPER, else a copy the daemon installed
 * under `screen-helper/` (the first layout kept one copy at the root, later ones a folder per
 * version). Only checks that the file exists; never runs it.
 */
export async function installedHelper(
  dataDir: string,
  configured: string | undefined,
): Promise<string | undefined> {
  if (configured) return (await isFile(configured)) ? configured : undefined;
  const root = join(dataDir, "screen-helper");
  const candidates = [join(root, executable)];
  try {
    for (const entry of await readdir(root, { withFileTypes: true }))
      if (entry.isDirectory() && /^[a-f0-9]{24}$/.test(entry.name))
        candidates.push(join(root, entry.name, executable));
  } catch {
    return undefined;
  }
  for (const candidate of candidates) if (await isFile(candidate)) return candidate;
  return undefined;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
