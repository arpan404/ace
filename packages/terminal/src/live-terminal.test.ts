import { expect, test } from "vitest";
import { TerminalManager, type PtyBackend, type TerminalEvent } from "./index.ts";

const noop = () => {};
function fixture() {
  let data: (bytes: Buffer) => void = noop;
  let exit: (status: { code: number; signal: null }) => void = noop;
  const backend: PtyBackend = {
    pid: 42,
    write() {},
    resize() {},
    kill: async () => {},
    close: async () => {},
    onData(listener) {
      data = listener;
      return () => {};
    },
    onExit(listener) {
      exit = listener;
      return () => {};
    },
  };
  const manager = new TerminalManager({ dependencies: { backendFactory: () => backend } });
  const events: TerminalEvent[] = [];
  const terminal = manager.openLiveTerminal(
    { cwd: "/tmp", cols: 80, rows: 24, name: "auth" },
    (event) => events.push(event),
  );
  return {
    manager,
    terminal,
    events,
    data: (bytes: Buffer) => data(bytes),
    exit: () => exit({ code: 0, signal: null }),
  };
}

test.each(["callbacks", "frame limit"])(
  "auth output preserves UTF-8 split across %s",
  async (split) => {
    const f = fixture();
    const prefix = split === "callbacks" ? "" : "a".repeat(16383);
    const bytes = Buffer.from(`${prefix}😀é終`);
    if (split === "callbacks") {
      f.data(bytes.subarray(0, 1));
      f.data(bytes.subarray(1, 3));
      f.data(bytes.subarray(3));
    } else f.data(bytes);
    f.exit();
    await f.terminal.exited;
    expect(f.events.flatMap((event) => (event.type === "data" ? [event.data] : [])).join("")).toBe(
      `${prefix}😀é終`,
    );
    expect(f.events.at(-1)).toMatchObject({ type: "exit", nextOffset: bytes.length });
    await f.manager.closeAll();
  },
);

test("auth output flushes an incomplete final character before exit", async () => {
  const f = fixture();
  f.data(Buffer.from([0xf0, 0x9f]));
  f.exit();
  await f.terminal.exited;
  expect(f.events).toMatchObject([
    { type: "data", data: "�", offset: 0, endOffset: 2 },
    { type: "exit", nextOffset: 2 },
  ]);
  await f.manager.closeAll();
});
