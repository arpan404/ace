import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { explainSandboxRefusal } from "./sandbox-helper.ts";

/** A stand-in `cursorsandbox` whose start prints `stderr` and exits with `code`. */
async function helper(stderr: string, code: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ace-cursorsandbox-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "cursorsandbox");
  await writeFile(path, `#!/bin/sh\ncat >&2 <<'EOF'\n${stderr}\nEOF\nexit ${code}\n`);
  await chmod(path, 0o755);
  return path;
}

// What glibc 2.36's loader prints for @cursor/sdk-linux-arm64 1.0.35 on Debian 12.
const loader = [
  "/path/cursorsandbox: /lib/aarch64-linux-gnu/libc.so.6: version `GLIBC_2.38' not found (required by /path/cursorsandbox)",
  "/path/cursorsandbox: /lib/aarch64-linux-gnu/libc.so.6: version `GLIBC_2.39' not found (required by /path/cursorsandbox)",
].join("\n");

test("a helper built for a newer glibc names both versions, what is affected and what still works", async () => {
  const message = await explainSandboxRefusal({ helper: await helper(loader, 1), glibc: "2.36" });
  expect(message).toBe(
    "Cursor's sandbox helper needs glibc 2.39 and this system has 2.36, so Cursor can't run in Auto review, its sandboxed mode, on this machine. Full access still works; or run ace on a distribution with glibc 2.39 or newer.",
  );
});

test("a missing shared library is named so the person can install it", async () => {
  const stderr =
    "/path/cursorsandbox: error while loading shared libraries: libseccomp.so.2: cannot open shared object file: No such file or directory";
  const message = await explainSandboxRefusal({ helper: await helper(stderr, 127), glibc: "2.39" });
  expect(message).toMatch(/can't load libseccomp\.so\.2, .*Install the package that provides/);
});

test("a helper that starts fine leaves the refusal to the system, not the loader", async () => {
  const message = await explainSandboxRefusal({
    helper: await helper("usage: cursorsandbox", 0),
    restricted: false,
  });
  expect(message).toMatch(/reports this system unsupported.*Full access still works/);
});

test("under Ubuntu's user-namespace restriction the refusal names AppArmor and the one-time fix", async () => {
  const message = await explainSandboxRefusal({
    helper: await helper("usage: cursorsandbox", 0),
    restricted: true,
  });
  expect(message).toBe(
    "Ubuntu's AppArmor blocks the user namespaces Cursor's sandbox helper needs, so Cursor can't run in Auto review, its sandboxed mode, on this machine. Set up the sandbox in ace's desktop app, or run `ace doctor fix linux.cursor-sandbox` for the one-time commands; Full access still works.",
  );
});

test("an old glibc is named even where AppArmor would also block the helper", async () => {
  const message = await explainSandboxRefusal({
    helper: await helper(loader, 1),
    glibc: "2.36",
    restricted: true,
  });
  expect(message).toMatch(/^Cursor's sandbox helper needs glibc 2\.39 and this system has 2\.36/);
});

test("a helper that isn't installed says so instead of a loader error", async () => {
  expect(await explainSandboxRefusal({ helper: "/nonexistent/cursorsandbox" })).toMatch(
    /helper is not installed with this ace/,
  );
  expect(await explainSandboxRefusal({ helper: undefined })).toMatch(/not installed/);
});
