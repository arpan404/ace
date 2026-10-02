import { afterEach, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  const results = await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  for (const result of results) if (result.status === "rejected") throw result.reason;
});

test("an exited terminal reserves its group until daemon death releases the lease", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-terminal-daemon-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, ".bash_profile"), "PS1=''; stty -echo; printf '__READY__\\n'\n");
  const controller = new AbortController();
  cleanups.push(async () => {
    controller.abort();
  });
  const source = `
    import { TerminalManager, createPosixBackendFactory } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
    import { execFile } from 'node:child_process';
    import { promisify } from 'node:util';
    const home = process.argv[1];
    const manager = new TerminalManager({ dependencies: { backendFactory: createPosixBackendFactory(undefined, home) } });
    const terminal = manager.openTerminal({ cwd: home, shell: '/bin/bash', env: {HOME: home, BASH_SILENCE_DEPRECATION_WARNING: '1'}, cols: 80, rows: 24, name: 'daemon death' });
    const watcher = terminal.attach();
    let output = '';
    for await (const event of watcher) {
      if (event.type === 'data') output += event.data;
      if (output.includes('__READY__')) break;
    }
    terminal.write('exit 0\\r');
    await terminal.exited;
    const { stdout } = await promisify(execFile)('ps', ['-e', '-o', 'pid=,pgid=,stat=']);
    const member = stdout.split('\\n').map(line => line.trim().split(/\\s+/)).find(fields => Number(fields[1]) === terminal.pid && Number(fields[0]) !== terminal.pid && !fields[2]?.startsWith('Z'));
    if (!member) throw new Error('Terminal group was not reserved');
    console.log(member[0]);
    process.exit(0); // Simulate daemon death without closeAll().
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", source, home],
    { signal: controller.signal },
  );
  const pid = Number(stdout.trim());
  expect(pid).toBeGreaterThan(0);
  for (;;) {
    const table = await promisify(execFile)("ps", ["-e", "-o", "pid=,stat="]);
    const state = table.stdout
      .split("\n")
      .find((line) => Number(line.trim().split(/\s+/)[0]) === pid)
      ?.trim()
      .split(/\s+/)[1];
    if (state === undefined || state.startsWith("Z")) break;
    await setImmediate();
  }
});
