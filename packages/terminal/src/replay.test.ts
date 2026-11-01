import { expect, onTestFinished, test } from "vitest";
import { TerminalManager, type PtyBackend } from "./index.ts";
import type { ExitStatus } from "./types.ts";
import { collect } from "./test-support.ts";

/*
 * Replay offsets are raw PTY bytes while events carry text. These cases feed exact byte
 * sequences through a scripted backend; terminal.process.test.ts keeps the real-PTY case
 * for a character split across native reads.
 */
function open(scrollbackBytes?: number) {
  let output: ((bytes: Buffer) => void) | undefined;
  let exit: ((status: ExitStatus) => void) | undefined;
  const backend: PtyBackend = {
    pid: 1,
    write() {},
    resize() {},
    onData(listener) {
      output = listener;
      return () => {};
    },
    onExit(listener) {
      exit = listener;
      return () => {};
    },
    async kill() {
      exit?.({ code: 0, signal: 9 });
    },
    async close() {
      exit?.({ code: 0, signal: null });
    },
  };
  const manager = new TerminalManager({
    graceMs: 0,
    ...(scrollbackBytes === undefined ? {} : { scrollbackBytes }),
    dependencies: { backendFactory: () => backend },
  });
  onTestFinished(() => manager.closeAll());
  const terminal = manager.openTerminal({
    cwd: "/tmp",
    shell: "/bin/sh",
    cols: 80,
    rows: 24,
    name: "replay",
  });
  return {
    terminal,
    write: (...parts: (string | number[])[]) =>
      output?.(Buffer.concat(parts.map((part) => Buffer.from(part)))),
    exit: async () => {
      exit?.({ code: 0, signal: null });
      await terminal.exited;
    },
  };
}

test("offsets inside a UTF-8 character skip its continuation bytes and mark truncation", async () => {
  const { terminal, write, exit } = open();
  write("🙂AFTER\r\n");
  await exit();
  expect((await collect(terminal.attach({ fromOffset: 1 })))[0]).toMatchObject({
    type: "data",
    offset: 4,
    data: "AFTER\r\n",
    truncatedBefore: true,
  });
});

test("an exact invalid continuation byte offset replays replacement text without truncation", async () => {
  const { terminal, write, exit } = open();
  write([0x80], "A");
  await exit();
  expect((await collect(terminal.attach({ fromOffset: 0 })))[0]).toMatchObject({
    type: "data",
    offset: 0,
    endOffset: 2,
    data: "�A",
    truncatedBefore: false,
  });
});

test("wrapped UTF-8 interiors are skipped while retained invalid bytes still replay", async () => {
  const { terminal, write, exit } = open(32);
  write("x".repeat(31), "🙂", [0x80], "A".repeat(28));
  await exit();
  const oldest = terminal.snapshot().oldestOffset;
  expect((await collect(terminal.attach({ fromOffset: oldest })))[0]).toMatchObject({
    type: "data",
    offset: oldest + 3,
    data: "�" + "A".repeat(28),
    truncatedBefore: true,
  });
});

test("a standalone invalid byte at the wrapped oldest offset is retained exactly", async () => {
  const { terminal, write, exit } = open(32);
  write("x".repeat(32), [0x80], "A".repeat(31));
  await exit();
  const oldest = terminal.snapshot().oldestOffset;
  expect((await collect(terminal.attach({ fromOffset: oldest })))[0]).toMatchObject({
    type: "data",
    offset: oldest,
    endOffset: oldest + 32,
    data: "�" + "A".repeat(31),
    truncatedBefore: false,
  });
});

test("resuming inside an incomplete character waits and skips its entire valid suffix", async () => {
  const { terminal, write, exit } = open();
  write([0xe2, 0x82]);
  const watcher = terminal.attach({ fromOffset: 1 });
  const next = watcher.next();
  write([0xac], "DONE\r\n");
  expect((await next).value).toMatchObject({
    type: "data",
    offset: 3,
    data: "DONE\r\n",
    truncatedBefore: true,
  });
  await exit();
});

test("default retention keeps the newest four MiB of a larger stream", async () => {
  const { terminal, write, exit } = open();
  for (let chunk = 0; chunk < 80; chunk++) write("x".repeat(65536));
  write("END");
  await exit();
  const output = (await collect(terminal.attach({ fromOffset: 0 })))
    .flatMap((event) => (event.type === "data" ? [event.data] : []))
    .join("");
  expect(Buffer.byteLength(output)).toBe(4 * 1024 * 1024);
  expect(output.endsWith("xEND")).toBe(true);
});
