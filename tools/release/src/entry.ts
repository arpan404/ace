// oxlint-disable-next-line import/no-unassigned-import -- First: back to the folder ace was started from, before any module reads process.cwd().
import "@ace/service/launch-directory-entry";
import { releaseCommand } from "./runtime.ts";
try {
  if (!(await releaseCommand(process.argv.slice(2)))) await import("@ace/daemon/cli");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
