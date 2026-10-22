import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  HOME_FORMAT_FILE,
  HOME_FORMAT_VERSION,
  formatName,
  markerVersion,
} from "@ace/service/home";
import { readHead } from "./install-path.ts";
import type { Verdict } from "./install-versions.ts";

/** The format the data folder records: a number, "none" (no data), or "unmarked" data. */
export async function storedFormat(dataDir: string): Promise<number | "none" | "unmarked"> {
  const names = await readdir(dataDir).catch(() => undefined);
  if (!names || names.length === 0) return "none";
  if (!names.includes(HOME_FORMAT_FILE)) return "unmarked";
  const text = await readHead(join(dataDir, HOME_FORMAT_FILE), 4096);
  return markerVersion(text ?? "") ?? "unmarked";
}

/**
 * Compares the data folder's format with what this build reads, the same way the daemon does
 * before it opens anything. Read-only: it never writes, backs up or migrates.
 */
export function dataFormatVerdict(
  dataDir: string,
  stored: number | "none" | "unmarked",
  supported: number = HOME_FORMAT_VERSION,
): Verdict {
  const current = formatName(supported);
  if (stored === "none")
    return {
      status: "ok",
      message: `No ace data in ${dataDir} yet; ace creates it in format ${current} on first start`,
      fix: "Nothing to do.",
    };
  const from = stored === "unmarked" ? 0 : stored;
  if (from > supported)
    return {
      status: "fail",
      message: `The data in ${dataDir} is format ${formatName(from)}, written by a newer ace. This build reads only ${current}, so it can't open it`,
      fix: "Update ace (the app and the ace command) to the newest release, or open the newer ace that wrote this data.",
    };
  if (from < supported)
    return {
      status: "ok",
      message: `The data in ${dataDir} is format ${formatName(from)}, older than this build's ${current}. On its next start ace moves it aside to ${dataDir}-v${from} and starts fresh`,
      fix: "Nothing to do; the old data stays in the backup folder.",
    };
  return {
    status: "ok",
    message: `Data format ${current} in ${dataDir}, the format this build reads`,
    fix: "Nothing to do.",
  };
}
