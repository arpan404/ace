import { expect, test } from "vitest";
import { spawn, execFile } from "node:child_process";
import { spawn as spawnPty } from "node-pty";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { TerminalManager, createPosixBackendFactory } from "./index.ts";
import { TerminalProcessSchema } from "@ace/protocol";

async function settleCleanup(tasks: Promise<unknown>[]) {
  const results = await Promise.allSettled(tasks);
  for (const result of results) if (result.status === "rejected") throw result.reason;
}

const owner = "7c48b6c8-ef6f-4ef6-9441-ff1a406fc885";

test("kernel group pinning rejects a foreign session even when discovery claims it is owned", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-terminal-foreign-"));
  const foreign = spawn(
    process.execPath,
    [
      "-e",
      `
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', () => process.stdout.write('pong\\n'));
    process.stdout.write('ready\\n');
  `,
    ],
    { detached: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  const pid = foreign.pid;
  const ended = new Promise<void>((resolve) => foreign.once("exit", () => resolve()));
  let nativePid = 0;
  let includeForeign = true;
  const manager = new TerminalManager({
    graceMs: 0,
    dependencies: {
      createSessionId: () => owner,
      backendFactory: createPosixBackendFactory(
        {
          spawn(shell, args, options) {
            const native = spawnPty(shell, args, options);
            nativePid = native.pid;
            return native;
          },
          processes: {
            async read() {
              const { stdout } = await promisify(execFile)("ps", ["-e", "-o", "pid=,pgid=,stat="]);
              const rows = stdout
                .split("\n")
                .filter((line) => line.trim())
                .map((line) => {
                  const [processId, group, state] = line.trim().split(/\s+/);
                  return TerminalProcessSchema.parse({
                    pid: Number(processId),
                    group: Number(group),
                    state,
                    owner,
                  });
                })
                .filter((row) => row.group === nativePid);
              if (includeForeign && pid !== undefined)
                rows.push({ pid, group: pid, state: "R", owner });
              return rows;
            },
            signal(group, signal) {
              process.kill(-group, signal);
            },
            stopShell() {
              process.kill(nativePid, "SIGSTOP");
            },
          },
        },
        home,
      ),
    },
  });
  try {
    if (pid === undefined) throw new Error("Foreign process failed to start");
    const reader = createInterface({ input: foreign.stdout })[Symbol.asyncIterator]();
    expect((await reader.next()).value).toBe("ready");
    await writeFile(join(home, ".bash_profile"), "PS1=''; stty -echo; printf '__READY__\\n'\n");
    const terminal = manager.openTerminal({
      cwd: home,
      shell: "/bin/bash",
      env: { HOME: home, BASH_SILENCE_DEPRECATION_WARNING: "1" },
      cols: 80,
      rows: 24,
      name: "group safety",
    });
    let output = "";
    for await (const event of terminal.attach()) {
      if (event.type === "data") output += event.data;
      if (output.includes("__READY__")) break;
    }
    await terminal.kill("SIGTERM");
    foreign.stdin.write("ping\n");
    expect((await reader.next()).value).toBe("pong");
  } finally {
    includeForeign = false;
    await settleCleanup([
      manager.closeAll(),
      (async () => {
        if (pid !== undefined) process.kill(-pid, "SIGKILL");
        await ended;
      })(),
      rm(home, { recursive: true, force: true }),
    ]);
  }
});
