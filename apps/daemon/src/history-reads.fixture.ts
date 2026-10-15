import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Process-only test gate: every file-system call on a path under one of ACE_TEST_WATCH_ROOTS (JSON), from
 * the main thread or any worker (workers inherit --import), is appended to
 * ACE_TEST_READ_LOG. It records accesses; it never changes what they return.
 */
const pathOf = (value: unknown): string | undefined =>
  typeof value === "string"
    ? value
    : value instanceof URL
      ? fileURLToPath(value)
      : Buffer.isBuffer(value)
        ? value.toString()
        : undefined;
const roots = z.array(z.string()).parse(JSON.parse(process.env.ACE_TEST_WATCH_ROOTS ?? "[]"));
const log = process.env.ACE_TEST_READ_LOG;
if (roots.length && log) {
  const append = fs.appendFileSync.bind(fs);
  const record = (name: string, value: unknown) => {
    const path = pathOf(value);
    if (path !== undefined && roots.some((root) => path.startsWith(root)))
      append(log, `${name} ${path}\n`);
  };
  const wrap = (target: Record<string, unknown>, names: readonly string[], prefix: string) => {
    for (const name of names) {
      const original = target[name];
      if (typeof original !== "function") continue;
      target[name] = function (this: unknown, ...args: unknown[]) {
        record(prefix + name, args[0]);
        return Reflect.apply(original, this, args);
      };
    }
  };
  const calls = [
    "open",
    "readFile",
    "readdir",
    "opendir",
    "stat",
    "lstat",
    "realpath",
    "watch",
    "access",
    "copyFile",
  ] as const;
  const fsTarget: Record<string, unknown> = fs as unknown as Record<string, unknown>;
  wrap(fsTarget, [...calls, ...calls.map((name) => `${name}Sync`), "createReadStream"], "");
  wrap(fs.promises as unknown as Record<string, unknown>, calls, "promises.");
  syncBuiltinESMExports();
}
