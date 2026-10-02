import { configureRealPtyTests } from "./real-pty-test-config.ts";
import { afterEach, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setImmediate } from "node:timers/promises";
import { fixture, until, collect, runNode, quote } from "./test-support.ts";
import type { TerminalEvent } from "./index.ts";

configureRealPtyTests();

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  const results = await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );
  if (failures.length) throw new AggregateError(failures, "Test cleanup failed");
});
async function open(options: Parameters<typeof fixture>[0] = {}) {
  const context = await fixture(options, (cleanup) => cleanups.push(cleanup));
  return context;
}
function text(events: TerminalEvent[]): string {
  return events
    .filter((event) => event.type === "data")
    .map((event) => event.data)
    .join("");
}

test("typed input echoes through a real PTY in the requested workspace", async () => {
  const { terminal, attachment, home } = await open();
  terminal.write("stty echo; printf 'ROUND_TRIP\\n'; pwd\r");
  expect(await until(attachment, `${home}\r\n`)).toContain("ROUND_TRIP\r\n");
  terminal.write("echo INPUT_ECHO\r");
  expect(await until(attachment, "INPUT_ECHO\r\n")).toContain("INPUT_ECHO");
});

test("stty size reports the resized PTY dimensions", async () => {
  const { terminal, attachment } = await open();
  terminal.write(
    `sh -c ${quote("printf 'SIZE_READY\\n'; read -r reply; stty size; printf 'SIZE_DONE\\n'")}\r`,
  );
  await until(attachment, "SIZE_READY\r\n");
  // Resize a foreground reader, after Bash has finished initializing Readline.
  terminal.resize(113, 37);
  terminal.write("release\r");
  expect(await until(attachment, "SIZE_DONE\r\n")).toContain("37 113\r\n");
  expect(terminal.snapshot()).toMatchObject({ cols: 113, rows: 37 });
});

test("ctrl-C interrupts a foreground sleep and returns control to the shell", async () => {
  const { terminal, attachment } = await open();
  terminal.write(`sh -c ${quote("printf 'RUNNING:%s:READY\\n' $$; exec sleep 1000")}\r`);
  const output = await until(attachment, ":READY\r\n");
  const pid = Number(output.match(/RUNNING:(\d+)/)?.[1]);
  expect(pid).toBeGreaterThan(0);
  // Confirm exec reached sleep before sending the terminal's interrupt character.
  for (;;) {
    const { stdout } = await promisify(execFile)("ps", ["-p", String(pid), "-o", "comm="]);
    if (stdout.trim().split("/").at(-1) === "sleep") break;
    await setImmediate();
  }
  terminal.write("\x03");
  // Bash 5 abandons the interrupted command line, so query on the next line.
  terminal.write("printf 'STATUS:%s\\n' $?\r");
  expect(await until(attachment, "STATUS:130\r\n")).toContain("STATUS:130");
});

test("late attachers receive final output and the retained exit code", async () => {
  const { terminal } = await open();
  terminal.write("printf 'FINAL_OUTPUT\\n'; exit 23\r");
  expect(await terminal.exited).toEqual({ code: 23, signal: null });
  const events = await collect(terminal.attach({ fromOffset: 0 }));
  expect(text(events)).toContain("FINAL_OUTPUT\r\n");
  expect(events.at(-1)).toEqual({
    type: "exit",
    status: { code: 23, signal: null },
    nextOffset: terminal.snapshot().nextOffset,
  });
  expect(terminal.snapshot().exit).toEqual({ code: 23, signal: null });
});

test("an old offset replays the retained tail and flags truncation only once", async () => {
  const { terminal } = await open({ scrollbackBytes: 128 * 1024 });
  runNode(terminal, "process.stdout.write('x'.repeat(256 * 1024)+'TAIL')");
  terminal.write("exit 0\r");
  await terminal.exited;
  const events = await collect(terminal.attach({ fromOffset: 0 }));
  const data = events.filter((event) => event.type === "data");
  expect(data[0]?.truncatedBefore).toBe(true);
  expect(data.length).toBeGreaterThan(1);
  expect(data.slice(1).every((event) => !event.truncatedBefore)).toBe(true);
  const snapshot = terminal.snapshot();
  expect(data[0]?.offset).toBe(snapshot.oldestOffset);
  expect(Buffer.byteLength(text(events))).toBe(128 * 1024);
  expect(text(events)).toContain("TAIL");
  expect(Buffer.from(snapshot.data, "base64").toString()).toBe(text(events));
});

test("two concurrent attachers receive identical bytes and byte offsets", async () => {
  const { terminal } = await open();
  const first = collect(terminal.attach({ fromOffset: 0 }));
  const second = collect(terminal.attach({ fromOffset: 0 }));
  terminal.write("printf 'SHARED:漢字🙂\\n'; exit 0\r");
  const [left, right] = await Promise.all([first, second]);
  expect(text(left)).toBe(text(right));
  expect(left.at(-1)).toEqual(right.at(-1));
  expect(text(left)).toContain("SHARED:漢字🙂\r\n");
  const data = left.filter((event) => event.type === "data");
  let previousEnd: number | undefined;
  for (const event of data) {
    expect(event.endOffset - event.offset).toBe(Buffer.byteLength(event.data));
    if (previousEnd !== undefined) expect(event.offset).toBe(previousEnd);
    previousEnd = event.endOffset;
  }
});

test("a UTF-8 character split across native reads is delivered whole", async () => {
  const { terminal, attachment } = await open();
  const offset = terminal.snapshot().nextOffset;
  terminal.write("printf '\\342\\202'; read -r reply; printf '\\254DONE\\n'\r");
  // Observe bytes in the public snapshot before releasing the shell's read barrier.
  while (terminal.snapshot().nextOffset < offset + 2) await setImmediate();
  expect(Buffer.from(terminal.snapshot().data, "base64").subarray(-2)).toEqual(
    Buffer.from([0xe2, 0x82]),
  );
  const next = attachment.next();
  terminal.write("release\r");
  const result = await next;
  expect(result.done).toBe(false);
  expect(result.value).toMatchObject({ type: "data", offset });
  if (result.done || result.value.type !== "data") throw new Error("Expected output");
  expect(result.value.data.startsWith("€")).toBe(true);
  const output = result.value.data.includes("DONE\r\n")
    ? result.value.data
    : result.value.data + (await until(attachment, "DONE\r\n"));
  expect(output).toBe("€DONE\r\n");
});

test("offsets inside a UTF-8 character skip its continuation bytes and mark truncation", async () => {
  const { terminal, attachment } = await open();
  const offset = terminal.snapshot().nextOffset;
  terminal.write("printf '🙂AFTER\\n'; exec /usr/bin/true\r");
  await terminal.exited;
  attachment.detach();
  const events = await collect(terminal.attach({ fromOffset: offset + 1 }));
  expect(events[0]).toMatchObject({
    type: "data",
    offset: offset + 4,
    data: "AFTER\r\n",
    truncatedBefore: true,
  });
});

test("environment overrides reach a login interactive shell with terminal colors enforced", async () => {
  const { manager, home } = await open();
  const terminal = manager.openTerminal({
    cwd: home,
    shell: "/bin/bash",
    cols: 80,
    rows: 24,
    name: "environment",
    env: { HOME: home, ACE_TERMINAL_TEST: "override", TERM: "wrong", COLORTERM: "wrong" },
  });
  const attachment = terminal.attach();
  await until(attachment, "__READY__\r\n");
  terminal.write(
    "shopt -q login_shell && printf 'LOGIN:'; case $- in *i*) printf 'INTERACTIVE:';; esac; printf '%s:%s:%s\\n' \"$ACE_TERMINAL_TEST\" \"$TERM\" \"$COLORTERM\"; exit\r",
  );
  expect(text(await collect(attachment))).toContain(
    "LOGIN:INTERACTIVE:override:xterm-256color:truecolor\r\n",
  );
});

test("detaching resolves a pending read without affecting the shell or other watchers", async () => {
  const { terminal, attachment } = await open();
  const pending = attachment.next();
  attachment.detach();
  expect((await pending).done).toBe(true);
  const other = terminal.attach({ fromOffset: terminal.snapshot().nextOffset });
  terminal.write("printf 'STILL_ALIVE\\n'\r");
  expect(await until(other, "STILL_ALIVE\r\n")).toContain("STILL_ALIVE");
  other.detach();
});

test("20 MiB drains with no readers while a stalled reader gets resync and bounded scrollback", async () => {
  const capacity = 64 * 1024;
  const { terminal, attachment } = await open({ scrollbackBytes: capacity });
  attachment.detach();
  const slow = terminal.attach({ fromOffset: terminal.snapshot().nextOffset });
  const before = terminal.snapshot().nextOffset;
  terminal.write("exec ");
  runNode(
    terminal,
    "const fs=require('node:fs'); const block=Buffer.alloc(65536,120); for(let i=0;i<320;i++)fs.writeSync(1,block); fs.writeSync(1,'END');",
  );
  expect(await terminal.exited).toEqual({ code: 0, signal: null });
  const snapshot = terminal.snapshot();
  expect(snapshot.nextOffset - before).toBe(20 * 1024 * 1024 + 3);
  expect(Buffer.from(snapshot.data, "base64").length).toBe(capacity);
  expect((await slow.next()).value).toEqual({
    type: "resync",
    oldestOffset: snapshot.oldestOffset,
    nextOffset: snapshot.nextOffset,
  });
  expect((await slow.next()).done).toBe(true);
  const replay = await collect(terminal.attach({ fromOffset: snapshot.oldestOffset }));
  expect(text(replay).endsWith("END")).toBe(true);
});

test("an active watcher continues after another watcher falls behind", async () => {
  const { terminal, attachment } = await open({ scrollbackBytes: 4096 });
  const slow = terminal.attach({ fromOffset: terminal.snapshot().nextOffset });
  for (let i = 0; i < 8; i++) {
    terminal.write(`printf '%01024dMARK${i}\\n' 0\r`);
    expect(await until(attachment, `MARK${i}\r\n`)).toContain(`MARK${i}`);
  }
  expect((await slow.next()).value).toMatchObject({ type: "resync" });
});

test("kill retains the POSIX signal for a late attacher", async () => {
  const { terminal } = await open();
  await terminal.kill("SIGKILL");
  expect((await terminal.exited).signal).toBe(9);
  expect((await collect(terminal.attach())).at(-1)).toMatchObject({
    type: "exit",
    status: { signal: 9 },
  });
});

test("closeAll kills a background child in a shell job-control group", async () => {
  const { terminal, manager, attachment } = await open();
  terminal.write("trap '' HUP; sleep 1000 & printf 'CHILD:%s:READY\\n' $!\r");
  const output = await until(attachment, ":READY\r\n");
  const pid = Number(output.match(/CHILD:(\d+)/)?.[1]);
  expect(pid).toBeGreaterThan(0);
  cleanups.unshift(async () => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* The child may already be reaped. */
    }
  });
  await manager.closeAll();
  const { stdout } = await promisify(execFile)("ps", ["-axo", "pid=,stat="]);
  const state = stdout
    .split("\n")
    .find((line) => Number(line.trim().split(/\s+/)[0]) === pid)
    ?.trim()
    .split(/\s+/)[1];
  expect(state === undefined || state.startsWith("Z")).toBe(true);
  expect(() => manager.openTerminal({ cwd: "/tmp", cols: 80, rows: 24, name: "closed" })).toThrow(
    "closed",
  );
  await manager.closeAll();
});

test("closeAll escalates when a foreground child ignores SIGTERM", async () => {
  const { terminal, manager, attachment } = await open();
  runNode(
    terminal,
    "process.on('SIGTERM',()=>{}); process.stdout.write('IGNORE:'+process.pid+':READY\\n'); setInterval(()=>{},100000);",
  );
  const output = await until(attachment, ":READY\r\n");
  const pid = Number(output.match(/IGNORE:(\d+)/)?.[1]);
  expect(pid).toBeGreaterThan(0);
  cleanups.unshift(async () => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* The child may already be reaped. */
    }
  });
  await manager.closeAll();
  const { stdout } = await promisify(execFile)("ps", ["-axo", "pid=,stat="]);
  const state = stdout
    .split("\n")
    .find((line) => Number(line.trim().split(/\s+/)[0]) === pid)
    ?.trim()
    .split(/\s+/)[1];
  expect(state === undefined || state.startsWith("Z")).toBe(true);
});

test("invalid dimensions and offsets fail before corrupting a running session", async () => {
  const { terminal, attachment } = await open();
  expect(() => terminal.resize(0, 1)).toThrow(RangeError);
  expect(() => terminal.attach({ fromOffset: -1 })).toThrow(RangeError);
  expect(() => terminal.attach({ fromOffset: terminal.snapshot().nextOffset + 1 })).toThrow(
    RangeError,
  );
  terminal.write(`printf '%s\\n' ${quote("VALID")}\r`);
  expect(await until(attachment, "VALID\r\n")).toContain("VALID");
});
