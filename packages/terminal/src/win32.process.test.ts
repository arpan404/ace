import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalManager } from "./index.ts";
import type { Terminal, TerminalAttachment } from "./index.ts";
import { collect, until } from "./test-support.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  const results = await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );
  if (failures.length) throw new AggregateError(failures, "Test cleanup failed");
});

function isPwsh(shell: string): boolean {
  return /pwsh|powershell/i.test(shell);
}

async function openWindows() {
  const home = await mkdtemp(join(tmpdir(), "ace-terminal-win32-"));
  const manager = new TerminalManager({ graceMs: 0 });
  const terminal: Terminal = manager.openTerminal({
    cwd: home,
    cols: 80,
    rows: 24,
    name: "win32",
  });
  const attachment: TerminalAttachment = terminal.attach();
  async function cleanup() {
    attachment.detach();
    const results = await Promise.allSettled([
      manager.closeAll(),
      rm(home, { recursive: true, force: true }),
    ]);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (failures.length) throw new AggregateError(failures, "Fixture cleanup failed");
  }
  cleanups.push(cleanup);
  // Transformed barrier: the shell must evaluate the sum. The literal result
  // never appears in the typed input, so its echo alone cannot satisfy this.
  if (isPwsh(terminal.snapshot().shell)) {
    terminal.write("123456+654321\r");
  } else {
    terminal.write("set /a 123456+654321\r");
  }
  await until(attachment, "777777");
  return { home, manager, terminal, attachment, cleanup };
}

test.skipIf(process.platform !== "win32")(
  "shell arithmetic output is transformed, not echoed input",
  async () => {
    const { terminal, attachment } = await openWindows();
    if (isPwsh(terminal.snapshot().shell)) {
      terminal.write("123*456\r");
    } else {
      terminal.write("set /a 123*456\r");
    }
    // 56088 appears only if the shell evaluated the expression.
    expect(await until(attachment, "56088")).toContain("56088");
  },
);

test.skipIf(process.platform !== "win32")("resize keeps ConPTY input flowing", async () => {
  const { terminal, attachment } = await openWindows();
  terminal.resize(113, 37);
  expect(terminal.snapshot()).toMatchObject({ cols: 113, rows: 37 });
  if (isPwsh(terminal.snapshot().shell)) {
    terminal.write("999+1\r");
  } else {
    terminal.write("set /a 999+1\r");
  }
  expect(await until(attachment, "1000")).toContain("1000");
});

test.skipIf(process.platform !== "win32")("UTF-8 output survives ConPTY", async () => {
  const { terminal, attachment } = await openWindows();
  // PowerShell only executes a quoted path with the call operator. The emoji
  // is emitted from code points so the literal never occurs in typed input.
  const invoke = isPwsh(terminal.snapshot().shell) ? "& " : "";
  terminal.write(
    `${invoke}${JSON.stringify(process.execPath)} -e "process.stdout.write('UTF8_'+String.fromCodePoint(0x1F600,0xE9,0x7D42)+'\\n')"\r`,
  );
  expect(await until(attachment, "UTF8_😀")).toContain("😀");
});

test.skipIf(process.platform !== "win32")(
  "shell exit retains history and close stops the tree",
  async () => {
    const { terminal } = await openWindows();
    terminal.write("exit 23\r");
    expect(await terminal.exited).toEqual({ code: 23, signal: null });
    expect(terminal.ownsProcesses).toBe(true);
    const events = await collect(terminal.attach({ fromOffset: 0 }));
    expect(events.at(-1)).toEqual({
      type: "exit",
      status: { code: 23, signal: null },
      nextOffset: terminal.snapshot().nextOffset,
    });
  },
);

test.skipIf(process.platform !== "win32")("close stops a running tree", async () => {
  const { manager, terminal } = await openWindows();
  terminal.write("ping -n 10 127.0.0.1\r");
  await manager.closeAll();
  expect(terminal.ownsProcesses).toBe(false);
});
