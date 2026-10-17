import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { createCodexAdapter } from "./index.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("a Codex older than ace's minimum is refused before app-server starts, naming both versions", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-codex-minimum-"));
  roots.push(root);
  const marker = join(root, "launched");
  const executable = join(root, "codex");
  await writeFile(
    executable,
    `#!/bin/sh\ncase "$1" in\n--version) echo "codex-cli 0.158.0";;\nlogin) echo "Logged in using ChatGPT";;\n*) touch '${marker}';;\nesac\n`,
  );
  await chmod(executable, 0o755);
  const ctx = {
    threadId: ThreadId.parse("minimum"),
    cwd: root,
    executable,
    env: { PATH: root, HOME: root },
    signal: new AbortController().signal,
    onFrame() {},
    onExit() {},
  };
  await expect(createCodexAdapter().openSession(ctx)).rejects.toMatchObject({
    code: "cli_too_old",
    installed: "0.158.0",
    required: "0.159.1",
    message:
      "Codex 0.158.0 is older than 0.159.1, the oldest version ace supports. Update Codex, then refresh.",
  });
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
});
