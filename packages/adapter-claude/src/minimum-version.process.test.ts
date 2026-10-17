import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { openSession } from "./session.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("a Claude Code older than ace's minimum is refused before it runs, naming both versions", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-claude-minimum-"));
  roots.push(root);
  const marker = join(root, "launched");
  const executable = join(root, "claude");
  await writeFile(
    executable,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.200 (Claude Code)"; else touch '${marker}'; fi\n`,
  );
  await chmod(executable, 0o755);
  const ctx = {
    threadId: ThreadId.parse("minimum"),
    cwd: root,
    executable,
    signal: new AbortController().signal,
    onFrame() {},
    onExit() {},
  };
  await expect(openSession(ctx)).rejects.toMatchObject({
    code: "cli_too_old",
    cli: "claude",
    installed: "2.1.200",
    required: "2.1.286",
    title: "Update Claude Code",
    message:
      "Claude Code 2.1.200 is older than 2.1.286, the oldest version ace supports. Update Claude Code, then refresh.",
  });
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
});
