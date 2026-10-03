import { afterEach, expect, test } from "vitest";
import { accessSync, constants } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, collect } from "./test-support.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  const results = await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );
  if (failures.length) throw new AggregateError(failures, "Shell fixture cleanup failed");
});

function restoreShell(value: string | undefined): void {
  if (value === undefined) delete process.env.SHELL;
  else process.env.SHELL = value;
}

test("the user's SHELL is launched with login and interactive arguments", async () => {
  const context = await fixture({}, (cleanup) => cleanups.push(cleanup));
  const original = process.env.SHELL;
  try {
    const shell = join(context.home, "shell");
    await writeFile(
      shell,
      '#!/bin/sh\nprintf "SELECTED:%s:%s\\n" "$1" "$2"\nexec /bin/bash "$@"\n',
      { mode: 0o755 },
    );
    process.env.SHELL = shell;
    const terminal = context.manager.openTerminal({
      cwd: context.home,
      env: { HOME: context.home },
      cols: 80,
      rows: 24,
      name: "default",
    });
    restoreShell(original);
    const output = collect(terminal.attach());
    terminal.write("printf 'DEFAULT_WORKS\\n'; exec /usr/bin/true\r");
    const events = await output;
    const data = events
      .filter((event) => event.type === "data")
      .map((event) => event.data)
      .join("");
    expect(data).toContain("SELECTED:-l:-i\r\n");
    expect(data).toContain("DEFAULT_WORKS\r\n");
    expect(terminal.snapshot().shell).toBe(shell);
  } finally {
    restoreShell(original);
    await context.cleanup();
  }
});

test("without SHELL the first installed fallback shell executes commands", async () => {
  const context = await fixture({}, (cleanup) => cleanups.push(cleanup));
  const original = process.env.SHELL;
  try {
    let expected = "/bin/bash";
    try {
      accessSync("/bin/zsh", constants.X_OK);
      expected = "/bin/zsh";
    } catch {
      /* Linux often has only bash. */
    }
    delete process.env.SHELL;
    const terminal = context.manager.openTerminal({
      cwd: context.home,
      env: { HOME: context.home },
      cols: 80,
      rows: 24,
      name: "fallback",
    });
    restoreShell(original);
    const output = collect(terminal.attach());
    terminal.write("printf 'FALLBACK_WORKS\\n'; exec /usr/bin/true\r");
    const events = await output;
    expect(
      events
        .filter((event) => event.type === "data")
        .map((event) => event.data)
        .join(""),
    ).toContain("FALLBACK_WORKS\r\n");
    expect(terminal.snapshot().shell).toBe(expected);
    expect(await terminal.exited).toEqual({ code: 0, signal: null });
  } finally {
    restoreShell(original);
    await context.cleanup();
  }
});
