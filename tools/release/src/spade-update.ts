import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { InstalledRelease } from "@ace/protocol";
import { isNewer, releasePointer } from "@ace/service";
import {
  describeSpadeSwap,
  reopenSpadeAdmission,
  spadeBinaryName,
  swapPrograms,
  takeSpadeUpdateMode,
  updateSpade,
  type SpadeSwapMode,
  type SpadeSwapResult,
} from "@ace/service/spade-service";

/**
 * Spade's half of `ace update apply` (ADR 0123): after the daemon's swap, Spade moves to the
 * `spade-server` the now-current release carries, at that release's version. Skipped when
 * Spade's service isn't registered or the release has no Spade.
 */
export async function updateSpadeToCurrent(
  root: string,
  mode: SpadeSwapMode,
  write: (line: string) => void,
): Promise<SpadeSwapResult> {
  const current = await releasePointer(root);
  const release = InstalledRelease.parse(
    JSON.parse(await readFile(join(root, current, "release.json"), "utf8")),
  );
  const result = await updateSpade({
    home: root,
    source: join(root, current, "spade", spadeBinaryName(process.platform)),
    version: release.version,
    mode,
  });
  const line = describeSpadeSwap(result);
  if (line) write(line);
  return result;
}

/**
 * `spade-follow <spade-server> <version>`: the desktop app's Spade swap after it restarted into
 * an update. The app's main process can't load the updater's natives, so it runs this on its
 * bundled runtime once its daemon answers. The mode is the one the app left before the restart.
 */
export async function spadeFollowCli(
  root: string,
  args: readonly string[],
  write: (line: string) => void,
): Promise<SpadeSwapResult> {
  const [source, version] = args;
  if (args.length !== 2 || !source || !version)
    throw new Error("Usage: spade-follow SPADE_SERVER VERSION");
  const result = await updateSpade({
    home: root,
    source,
    version,
    mode: await takeSpadeUpdateMode(root),
  });
  const line = describeSpadeSwap(result);
  if (line) write(line);
  return result;
}

const writeLine = (line: string) => process.stdout.write(`${line}\n`);

/**
 * `ace update apply`'s two programs (ADR 0123): the daemon's swap, then Spade's, never both
 * stopped at once. `--interrupt` swaps Spade `now`, anything else waits for it to be idle. An
 * up-to-date daemon still brings along a Spade an earlier failed swap left behind.
 */
export async function applyWithSpade(options: {
  root: string;
  installed: string;
  offered: string;
  interrupt: boolean | undefined;
  daemon(): Promise<unknown>;
}): Promise<void> {
  const mode = options.interrupt ? "now" : "idle";
  if (!isNewer(options.offered, options.installed))
    await updateSpadeToCurrent(options.root, mode, writeLine);
  await swapPrograms({
    daemon: options.daemon,
    spade: () => updateSpadeToCurrent(options.root, mode, writeLine),
  });
}

/** `ace update recover`: an updater that died with Spade's admission closed leaves it closed. */
export async function recoverSpade(root: string): Promise<void> {
  await reopenSpadeAdmission(root);
}

/** The release command `spade-follow`; a failed swap exits 1. */
export async function spadeReleaseCommand(root: string, args: readonly string[]): Promise<void> {
  const result = await spadeFollowCli(root, args, writeLine);
  if (result.kind === "failed") process.exitCode = 1;
}
