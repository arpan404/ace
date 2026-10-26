import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalManager } from "./index.ts";
import { collect, until } from "./test-support.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  const results = await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );
  if (failures.length) throw new AggregateError(failures, "Test cleanup failed");
});

/** A real ConPTY terminal on the host's default shell, past its first evaluated command. */
async function openConpty() {
  const home = await mkdtemp(join(tmpdir(), "ace-terminal-conpty-"));
  const manager = new TerminalManager({ graceMs: 0 });
  const terminal = manager.openTerminal({ cwd: home, cols: 80, rows: 24, name: "conpty" });
  const attachment = terminal.attach();
  cleanups.push(async () => {
    attachment.detach();
    // Windows keeps the shell's cwd locked until the tree has stopped.
    await manager.closeAll();
    await rm(home, { recursive: true, force: true });
  });
  const pwsh = /pwsh|powershell/i.test(terminal.snapshot().shell);
  /** Evaluates arithmetic in the shell; the result never appears in the typed input. */
  const evaluate = (sum: string) => terminal.write(pwsh ? `${sum}\r` : `set /a ${sum}\r`);
  evaluate("123456+654321");
  await until(attachment, "777777");
  return { manager, terminal, attachment, pwsh, evaluate };
}

describe.runIf(process.platform === "win32")("a ConPTY terminal", () => {
  test("the shell evaluates input instead of echoing it, before and after a resize", async () => {
    const { terminal, attachment, evaluate } = await openConpty();
    evaluate("123*456");
    expect(await until(attachment, "56088")).toContain("56088");
    terminal.resize(113, 37);
    expect(terminal.snapshot()).toMatchObject({ cols: 113, rows: 37 });
    evaluate("999+1");
    expect(await until(attachment, "1000")).toContain("1000");
  });

  test("ctrl-C at the prompt leaves the shell running", async () => {
    const { terminal, attachment, evaluate } = await openConpty();
    terminal.write("\x03");
    // Let the line editor finish cancelling before the next line arrives.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    evaluate("4000+321");
    const shellExit = terminal.exited.then((status) => {
      throw new Error(`The shell exited on ctrl-C: ${JSON.stringify(status)}`);
    });
    expect(await Promise.race([until(attachment, "4321"), shellExit])).toContain("4321");
    expect(terminal.ownsProcesses).toBe(true);
  });

  test("UTF-8 output survives ConPTY", async () => {
    const { terminal, attachment, pwsh } = await openConpty();
    // PowerShell only executes a quoted path with the call operator. The emoji is emitted from
    // code points so the literal never occurs in typed input.
    terminal.write(
      `${pwsh ? "& " : ""}${JSON.stringify(process.execPath)} -e "process.stdout.write('UTF8_'+String.fromCodePoint(0x1F600,0xE9,0x7D42)+'\\n')"\r`,
    );
    expect(await until(attachment, "UTF8_😀")).toContain("😀");
  });

  test("shell exit retains history and ownership until close", async () => {
    const { terminal } = await openConpty();
    terminal.write("exit 23\r");
    expect(await terminal.exited).toEqual({ code: 23, signal: null });
    expect(terminal.ownsProcesses).toBe(true);
    const events = await collect(terminal.attach({ fromOffset: 0 }));
    expect(events.at(-1)).toEqual({
      type: "exit",
      status: { code: 23, signal: null },
      nextOffset: terminal.snapshot().nextOffset,
    });
  });

  test("close stops a running child of the shell", async () => {
    const { manager, terminal } = await openConpty();
    terminal.write("ping -n 30 127.0.0.1\r");
    await manager.closeAll();
    expect(terminal.ownsProcesses).toBe(false);
  });
});
