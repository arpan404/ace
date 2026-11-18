import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
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
