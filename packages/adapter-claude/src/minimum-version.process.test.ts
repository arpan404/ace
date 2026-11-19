import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { openSession } from "./session.ts";
import { createClaudeAdapter } from "./index.ts";

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

test("a wrapper that selects its CLI from the environment is held to the minimum on every open", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-claude-version-"));
  roots.push(root);
  const executable = join(root, "claude");
  const fake = new URL("./testing/cli.ts", import.meta.url).href;
  // A large launcher, unchanged between opens, whose answer depends on the session's environment.
  await writeFile(
    executable,
    `#!${process.execPath}\n// ${"x".repeat(80 * 1024)}\n` +
      `if (process.argv.includes("--version")) {\n` +
      `  console.log(\`\${process.env.ACE_SELECTED_CLAUDE} (Claude Code)\`);\n  process.exit(0);\n}\n` +
      `await import(${JSON.stringify(fake)});\n`,
  );
  await chmod(executable, 0o755);
  const adapter = createClaudeAdapter({ executable });
  const open = (selected: string) =>
    adapter.openSession({
      threadId: ThreadId.parse("versions"),
      cwd: root,
      env: { ACE_SELECTED_CLAUDE: selected },
      signal: new AbortController().signal,
      onFrame() {},
      onExit() {},
    });
  await (await open("2.1.286")).close("shutdown");
  await expect(open("2.1.200")).rejects.toMatchObject({
    code: "cli_too_old",
    installed: "2.1.200",
  });
});
