import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execFile);
const Row = z.tuple([z.coerce.number().int().positive(), z.coerce.number().int().nonnegative()]);

/** ace's Chrome under `home` as the OS sees it: its browser process and that browser's renderers. */
export async function chromeProcesses(home: string) {
  const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,command="], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const rows = stdout
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .flatMap((match) =>
      match ? [{ ids: Row.parse([match[1], match[2]]), command: match[3] ?? "" }] : [],
    );
  const browser = rows.find(
    (row) => row.command.includes(`--user-data-dir=${home}`) && !row.command.includes("--type="),
  )?.ids[0];
  const renderers = rows
    .filter((row) => row.ids[1] === browser && row.command.includes("--type=renderer"))
    .map((row) => row.ids[0]);
  return { browser, renderers, commandLine: rows.find((row) => row.ids[0] === browser)?.command };
}
