import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { loginShellPath } from "./login-path.ts";

test.skipIf(process.platform === "win32")(
  "desktop waits for a slow login shell instead of selecting a different provider installation",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-login-path-"));
    const shell = join(root, "shell");
    try {
      await writeFile(
        shell,
        "#!/bin/sh\n/bin/sleep 3.2\nprintf '__ACE_PATH__/provider/current/bin:/usr/bin__ACE_PATH__'\n",
      );
      await chmod(shell, 0o755);
      expect(await loginShellPath({ SHELL: shell, PATH: "/provider/old/bin:/usr/bin" })).toBe(
        "/provider/current/bin:/usr/bin:/provider/old/bin",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "a login shell that ignores being stopped still answers the current PATH at the deadline, and is killed",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-login-path-"));
    const shell = join(root, "shell");
    const pidFile = join(root, "pid");
    try {
      await writeFile(
        shell,
        `#!/bin/sh\ntrap '' TERM\necho $$ > ${JSON.stringify(pidFile)}\nwhile :; do /bin/sleep 0.05; done\n`,
      );
      await chmod(shell, 0o755);
      const started = performance.now();
      const path = await loginShellPath(
        { SHELL: shell, PATH: "/usr/bin:/bin" },
        { timeoutMs: 300, killGraceMs: 200 },
      );
      expect(path).toBe("/usr/bin:/bin");
      expect(performance.now() - started).toBeLessThan(2_000);
      const pid = Number(await readFile(pidFile, "utf8"));
      // SIGTERM is ignored; SIGKILL follows the grace period.
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 3_000 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
