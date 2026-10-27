import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalManager } from "./index.ts";
import { collect, until } from "./test-support.ts";

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

/** PIDs a fixture published, once the file exists. */
async function published(path: string, output: () => string): Promise<number[]> {
  let text = "";
  await expect
    .poll(async () => (text = await readFile(path, "utf8").catch(() => "")), {
      timeout: 20_000,
      message: `nothing published; terminal output: ${JSON.stringify(output())}`,
    })
    .not.toBe("");
  return text.split(",").map(Number);
}

/** Everything the terminal prints, for failure messages. */
function transcript(terminal: { attach(): AsyncIterable<{ type: string; data?: string }> }) {
  let text = "";
  void (async () => {
    for await (const event of terminal.attach()) if (event.type === "data") text += event.data;
  })().catch(() => {});
  return () => text;
}

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

  test("close stops a running child of the shell before reporting the tree drained", async () => {
    const home = await mkdtemp(join(tmpdir(), "ace-terminal-child-"));
    const pids = join(home, "pids");
    const manager = new TerminalManager({ graceMs: 0 });
    const terminal = manager.openTerminal({
      cwd: home,
      cols: 80,
      rows: 24,
      name: "conpty-child",
      env: { ACE_PIDS: pids },
    });
    cleanups.push(async () => {
      await manager.closeAll();
      await rm(home, { recursive: true, force: true });
    });
    const output = transcript(terminal);
    const pwsh = /pwsh|powershell/i.test(terminal.snapshot().shell);
    terminal.write(
      `${pwsh ? "& " : ""}${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync(process.env.ACE_PIDS, String(process.pid)); setInterval(() => {}, 1000)"\r`,
    );
    const [child = 0] = await published(pids, output);
    expect(running(child)).toBe(true);
    await manager.closeAll();
    // Checked at once: ownership may only end after the child is gone.
    expect(terminal.ownsProcesses).toBe(false);
    expect(running(child)).toBe(false);
  });

  test("a child the shell starts at once is contained and ends with the terminal", async () => {
    const home = await mkdtemp(join(tmpdir(), "ace-terminal-startup-"));
    const pids = join(home, "pids");
    const manager = new TerminalManager({ graceMs: 0 });
    // A custom shell that starts a child before anything else, like an AutoRun or profile hook.
    const shell = [
      "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "require('node:fs').writeFileSync(process.env.ACE_PIDS, process.pid + ',' + c.pid);",
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const terminal = manager.openTerminal({
      cwd: home,
      shell: process.execPath,
      args: ["-e", shell],
      cols: 80,
      rows: 24,
      name: "conpty-startup",
      env: { ACE_PIDS: pids },
    });
    const output = transcript(terminal);
    cleanups.push(async () => {
      await manager.closeAll();
      await rm(home, { recursive: true, force: true });
    });
    const members = await published(pids, output);
    expect(members.filter(running)).toEqual(members);
    expect(terminal.ownsProcesses).toBe(true);
    await manager.closeAll();
    expect(terminal.ownsProcesses).toBe(false);
    expect(members.filter(running)).toEqual([]);
  });
});
