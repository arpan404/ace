import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { InstalledRelease } from "@ace/protocol";
import { releasePointer } from "@ace/service";
import {
  describeSpadeSwap,
  spadeBinaryName,
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
