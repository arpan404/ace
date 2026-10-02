import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { decodeProcesses, decodeSessionColumns, decodeNativeSessions } from "./decode.ts";

// The macOS ps session fields are masked kernel pointers, not POSIX session IDs.
// Its system JavaScript bridge can call libc getsid without a native addon or
// build/runtime dependency. Batch the calls in one invocation per inventory.
const sessionScript =
  'ObjC.import("stdlib"); ObjC.bindFunction("getsid", ["int", ["int"]]); function run(argv) { return JSON.stringify(JSON.parse(argv[0]).map(function(pid) { return {pid: pid, session: $.getsid(pid)}; })); }';

export function createProcessTable() {
  const run = promisify(execFile);
  async function read() {
    const darwin = process.platform === "darwin";
    const { stdout } = await run(
      "ps",
      [
        "-e",
        "-o",
        darwin ? "pid=,pgid=,stat=,comm=" : "pid=,pgid=,stat=,sid=",
        "-U",
        String(process.getuid?.()),
      ],
      { maxBuffer: 4 * 1024 * 1024, timeout: 5000 },
    );
    const rows = decodeProcesses(stdout);
    if (!darwin) {
      const sessions = new Map(decodeSessionColumns(stdout).map((row) => [row.pid, row.session]));
      return rows.map((row) => Object.assign(row, { session: sessions.get(row.pid) ?? -1 }));
    }
    const result = await run(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", sessionScript, JSON.stringify(rows.map((row) => row.pid))],
      { maxBuffer: 4 * 1024 * 1024, timeout: 5000 },
    );
    const sessions = new Map(
      decodeNativeSessions(result.stdout).map((row) => [row.pid, row.session]),
    );
    return rows.map((row) => Object.assign(row, { session: sessions.get(row.pid) ?? -1 }));
  }
  let reading: ReturnType<typeof read> | undefined;
  return () => {
    reading ??= read().finally(() => {
      reading = undefined;
    });
    return reading;
  };
}
