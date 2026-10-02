import { afterEach, test } from "vitest";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { TerminalProcessSchema } from "@ace/protocol";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  const results = await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  for (const result of results) if (result.status === "rejected") throw result.reason;
});

test("daemon death during shell freeze stops the shell, keeper and background jobs", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-terminal-frozen-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  await writeFile(
    join(home, ".bash_profile"),
    "PS1=''; stty -echo; trap '' TERM HUP; printf '__READY__\\n'\n",
  );
  const source = `
    import { TerminalManager, createPosixBackendFactory } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
    import { spawn as spawnPty } from 'node-pty';
    import { execFile, execFileSync } from 'node:child_process';
    import { promisify } from 'node:util';
    import { openSync, closeSync, existsSync, constants } from 'node:fs';
    import { join } from 'node:path';
    import { TerminalProcessSchema } from '@ace/protocol';
    const home = process.argv[1];
    const owner = '7c48b6c8-ef6f-4ef6-9441-ff1a406fc885';
    const path = join(home, 'lifetime');
    const readyPath = join(home, 'ready');
    execFileSync('/usr/bin/mkfifo', [path]);
    const writer = openSync(path, constants.O_RDWR | constants.O_NONBLOCK);
    let native;
    let rows = [];
    let frozen = false;
    let job = 0;
    function announceFreeze() {
      frozen = true;
      const keeper = rows.find(row => row.pid !== native.pid);
      if (!keeper) throw new Error('Missing keeper');
      console.log(JSON.stringify({ pid: keeper.pid, group: native.pid, job }));
    }
    const manager = new TerminalManager({ graceMs: 0, dependencies: {
      createSessionId: () => owner,
      backendFactory: createPosixBackendFactory({
        spawn(shell, args, options) { native = spawnPty(shell, args, options); return native; },
        createLease: () => ({ path, readyPath, ready: () => existsSync(readyPath), alive: () => true, dispose: () => closeSync(writer) }),
        processes: {
          async read() {
            if (frozen) return new Promise(() => {}); // Hold the inventory at an explicit barrier.
            const { stdout } = await promisify(execFile)('ps', ['-e', '-o', 'pid=,pgid=,stat=']);
            rows = stdout.split('\\n').filter(line => line.trim()).map(line => {
              const [pid, group, state] = line.trim().split(/\\s+/);
              return TerminalProcessSchema.parse({ pid: Number(pid), group: Number(group), state, owner });
            }).filter(row => row.group === native.pid || row.pid === job);
            return rows;
          },
          async signalOwned(group, signal) {
            // The controlled edge targets this test's recorded job only. The
            // production keeper owns daemon-death cleanup in this scenario.
            if (group !== job) return false;
            process.kill(-group, signal);
            if (signal === 'SIGSTOP') announceFreeze();
            return true;
          },
          signal(group, signal) {
            process.kill(-group, signal);
            if (signal === 'SIGSTOP' && group === native.pid) announceFreeze();
          },
          stopShell() { process.kill(native.pid, 'SIGSTOP'); },
        },
      }),
    }});
    const terminal = manager.openTerminal({ cwd: home, shell: '/bin/bash', env: { HOME: home, BASH_SILENCE_DEPRECATION_WARNING: '1' }, cols: 80, rows: 24, name: 'frozen daemon' });
    let output = '';
    for await (const event of terminal.attach()) {
      if (event.type === 'data') output += event.data;
      if (output.includes('__READY__')) break;
    }
    terminal.write('sleep 1000 >/dev/null 2>&1 & printf "__JOB__%s__\\n" "$!"\\r');
    output = '';
    for await (const event of terminal.attach()) {
      if (event.type === 'data') output += event.data;
      const match = /__JOB__(\\d+)__/.exec(output);
      if (match) { job = Number(match[1]); break; }
    }
    setInterval(() => {}, 100000); // Keep the simulated daemon alive at the barrier.
    await manager.closeAll();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, home], {
    cwd: import.meta.dirname,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  cleanups.push(async () => {
    child.kill("SIGKILL");
  });
  const ended = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let output = "";
  for await (const chunk of child.stdout) {
    output += String(chunk);
    if (output.includes("\n")) break;
  }
  if (!output.includes("\n")) throw new Error(`Daemon ended before freezing: ${stderr}`);
  const { group, job } = TerminalProcessSchema.pick({ pid: true, group: true })
    .extend({ job: TerminalProcessSchema.shape.pid })
    .parse(JSON.parse(output));
  cleanups.unshift(async () => {
    for (const ownedGroup of [job, group]) {
      try {
        process.kill(-ownedGroup, "SIGKILL");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
  });
  child.kill("SIGKILL");
  await ended;
  for (;;) {
    const { stdout } = await promisify(execFile)("ps", ["-e", "-o", "pid=,pgid=,stat="]);
    const live = stdout.split("\n").filter((line) => {
      const [pid, pgid, state] = line.trim().split(/\s+/);
      return (
        (Number(pid) === group ||
          Number(pid) === job ||
          Number(pgid) === job ||
          Number(pgid) === group) &&
        !state?.startsWith("Z")
      );
    });
    if (!live.length) break;
    await setImmediate();
  }
});
