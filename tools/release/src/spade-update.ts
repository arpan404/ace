import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { InstalledRelease } from "@ace/protocol";
import { releasePointer } from "@ace/service";
import {
  describeSpadeSwap,
  spadeBinaryName,
  takeSpadeUpdateMode,
  updateSpade,
  type SpadeSwapMode,
  type SpadeSwapResult,
} from "@ace/service/spade";

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
