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

test("daemon death after public STOP kills the default backend's shell and pinned jobs", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-terminal-pinned-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  await writeFile(
    join(home, ".bash_profile"),
    "PS1=''; stty -echo; trap '' TERM HUP; printf '__READY__\\n'\n",
  );
  const source = `
    import { TerminalManager, createPosixBackendFactory } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
    const home = process.argv[1];
    const manager = new TerminalManager({dependencies: {backendFactory: createPosixBackendFactory(undefined, home)}});
    const terminal = manager.openTerminal({cwd: home, shell: '/bin/bash', env: {HOME: home, BASH_SILENCE_DEPRECATION_WARNING: '1'}, cols: 80, rows: 24, name: 'pinned EOF'});
    const watcher = terminal.attach();
    let output = '';
    async function readUntil(marker) {
      while (!output.includes(marker)) {
        const event = await watcher.next();
        if (event.done || event.value.type !== 'data') throw new Error('Terminal ended');
        output += event.value.data;
      }
    }
    await readUntil('__READY__');
    terminal.write('sleep 1000 >/dev/null 2>&1 & printf "__JOB__%s__\\n" "$!"\\r');
    await readUntil('__JOB__');
    while (!/__JOB__(\\d+)__/.test(output)) {
      const event = await watcher.next();
      if (event.done || event.value.type !== 'data') throw new Error('Missing job PID');
      output += event.value.data;
    }
    const match = /__JOB__(\\d+)__/.exec(output);
    await terminal.kill('SIGSTOP');
    console.log(JSON.stringify({pid: terminal.pid, group: Number(match[1])}));
    setInterval(() => {}, 100000);
  `;
  const daemon = spawn(process.execPath, ["--input-type=module", "-e", source, home], {
    cwd: import.meta.dirname,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ended = new Promise<void>((resolve) => daemon.once("exit", () => resolve()));
  cleanups.push(async () => {
    daemon.kill("SIGKILL");
  });
  let output = "";
  let stderr = "";
  daemon.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  for await (const chunk of daemon.stdout) {
    output += String(chunk);
    if (output.includes("\n")) break;
  }
  if (!output.includes("\n")) throw new Error(`Daemon ended before pause: ${stderr}`);
  const { pid: shell, group: job } = TerminalProcessSchema.pick({ pid: true, group: true }).parse(
    JSON.parse(output),
  );
  cleanups.unshift(async () => {
    for (const group of [job, shell]) {
      try {
        process.kill(-group, "SIGKILL");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
  });
  daemon.kill("SIGKILL");
  await ended;
  for (;;) {
    const { stdout } = await promisify(execFile)("ps", ["-e", "-o", "pid=,pgid=,stat="]);
    const live = stdout.split("\n").some((line) => {
      const [pid, group, state] = line.trim().split(/\s+/);
      return (
        (Number(pid) === shell || Number(group) === shell || Number(group) === job) &&
        !state?.startsWith("Z")
      );
    });
    if (!live) break;
    await setImmediate();
  }
});
