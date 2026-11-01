import { afterEach, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TerminalManager } from "./index.ts";
import { fixture, until } from "./test-support.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  const results = await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  for (const result of results) if (result.status === "rejected") throw result.reason;
});
async function open(options: Parameters<typeof fixture>[0] = {}) {
  const context = await fixture(options, (cleanup) => cleanups.push(cleanup));
  return context;
}

test("closeAll owns a disowned background job after its shell exits naturally", async () => {
  const { terminal, manager, attachment } = await open();
  terminal.write("set +H; trap '' HUP; printf 'CONFIGURED\\n'\r");
  await until(attachment, "CONFIGURED\r\n");
  terminal.write(
    "sleep 1000 </dev/null >/dev/null 2>&1 & printf 'ORPHAN:%s:READY\\n' $!; disown\r",
  );
  const output = await until(attachment, ":READY\r\n");
  const pid = Number(output.match(/ORPHAN:(\d+)/)?.[1]);
  expect(pid).toBeGreaterThan(0);
  cleanups.push(async () => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* Already stopped. */
    }
  });
  terminal.write("exit\r");
  await terminal.exited;
  await manager.closeAll();
  const { stdout } = await promisify(execFile)("ps", ["-axo", "pid=,stat="]);
  const state = stdout
    .split("\n")
    .find((line) => Number(line.trim().split(/\s+/)[0]) === pid)
    ?.trim()
    .split(/\s+/)[1];
  expect(state === undefined || state.startsWith("Z")).toBe(true);
});

test("dimensions outside native winsize bounds reject on spawn and preserve resize state", async () => {
  const { terminal, manager, home, attachment } = await open();
  expect(() =>
    manager.openTerminal({ cwd: home, cols: 65537, rows: 65538, name: "overflow" }),
  ).toThrow(RangeError);
  expect(() => terminal.resize(65537, 65538)).toThrow(RangeError);
  expect(terminal.snapshot()).toMatchObject({ cols: 80, rows: 24 });
  terminal.write("stty size; printf 'SIZE_DONE\\n'\r");
  expect(await until(attachment, "SIZE_DONE\r\n")).toContain("24 80\r\n");
});

test("injected spawn failure is reported without creating a native process", async () => {
  const options = {
    graceMs: 0,
    dependencies: {
      backendFactory: () => {
        throw new Error("injected spawn failure");
      },
    },
  };
  const manager = new TerminalManager(options);
  cleanups.push(() => manager.closeAll());
  expect(() =>
    manager.openTerminal({ cwd: "/tmp", shell: "/bin/bash", cols: 80, rows: 24, name: "failure" }),
  ).toThrow("injected spawn failure");
});

test("writes and resize reject after exit without changing retained output or dimensions", async () => {
  const { terminal } = await open();
  terminal.write("exit 0\r");
  await terminal.exited;
  const snapshot = terminal.snapshot();
  expect(() => terminal.write("echo TOO_LATE\r")).toThrow("exited");
  expect(() => terminal.resize(90, 30)).toThrow("exited");
  expect(terminal.snapshot()).toEqual(snapshot);
});
