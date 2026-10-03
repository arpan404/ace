import { afterEach, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TerminalManager } from "./index.ts";
import { fixture, until, collect, runNode } from "./test-support.ts";

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

test("an exact invalid continuation byte offset replays replacement text without truncation", async () => {
  const { terminal } = await open();
  const offset = terminal.snapshot().nextOffset;
  terminal.write("printf '\\200A'; exec /usr/bin/true\r");
  await terminal.exited;
  const events = await collect(terminal.attach({ fromOffset: offset }));
  expect(events[0]).toMatchObject({
    type: "data",
    offset,
    endOffset: offset + 2,
    data: "�A",
    truncatedBefore: false,
  });
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

test("wrapped UTF-8 interiors are skipped while retained invalid bytes still replay", async () => {
  const { terminal } = await open({ scrollbackBytes: 32 });
  terminal.write("exec ");
  runNode(
    terminal,
    "process.stdout.write(Buffer.concat([Buffer.alloc(31,120),Buffer.from('🙂'),Buffer.from([128]),Buffer.alloc(28,65)]))",
  );
  await terminal.exited;
  const oldest = terminal.snapshot().oldestOffset;
  const events = await collect(terminal.attach({ fromOffset: oldest }));
  expect(events[0]).toMatchObject({
    type: "data",
    offset: oldest + 3,
    data: "�" + "A".repeat(28),
    truncatedBefore: true,
  });
});

test("a standalone invalid byte at the wrapped oldest offset is retained exactly", async () => {
  const { terminal } = await open({ scrollbackBytes: 32 });
  terminal.write("exec ");
  runNode(
    terminal,
    "process.stdout.write(Buffer.concat([Buffer.alloc(32,120),Buffer.from([128]),Buffer.alloc(31,65)]))",
  );
  await terminal.exited;
  const oldest = terminal.snapshot().oldestOffset;
  const events = await collect(terminal.attach({ fromOffset: oldest }));
  expect(events[0]).toMatchObject({
    type: "data",
    offset: oldest,
    endOffset: oldest + 32,
    data: "�" + "A".repeat(31),
    truncatedBefore: false,
  });
});

test("default retention preserves four MiB of a larger real PTY stream", async () => {
  const { terminal } = await open();
  terminal.write("exec ");
  runNode(
    terminal,
    "const fs=require('node:fs');const b=Buffer.alloc(65536,120);for(let i=0;i<80;i++)fs.writeSync(1,b)",
  );
  await terminal.exited;
  const events = await collect(terminal.attach({ fromOffset: 0 }));
  const output = events
    .filter((event) => event.type === "data")
    .map((event) => event.data)
    .join("");
  expect(Buffer.byteLength(output)).toBe(4 * 1024 * 1024);
  expect(output).toBe("x".repeat(4 * 1024 * 1024));
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

test("resuming inside an incomplete character waits and skips its entire valid suffix", async () => {
  const { terminal } = await open();
  const offset = terminal.snapshot().nextOffset;
  terminal.write("printf '\\342\\202'; read -r reply; printf '\\254DONE\\n'; exec /usr/bin/true\r");
  while (terminal.snapshot().nextOffset < offset + 2)
    await new Promise<void>((resolve) => setImmediate(resolve));
  const watcher = terminal.attach({ fromOffset: offset + 1 });
  const next = watcher.next();
  terminal.write("release\r");
  expect((await next).value).toMatchObject({
    type: "data",
    offset: offset + 3,
    data: "DONE\r\n",
    truncatedBefore: true,
  });
  await terminal.exited;
});
