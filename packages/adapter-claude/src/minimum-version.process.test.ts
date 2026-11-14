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

test("an unchanged Claude CLI reports its version once, and a replaced one is read again", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-claude-version-"));
  roots.push(root);
  const probes = join(root, "probes");
  const executable = join(root, "claude");
  const fake = new URL("./testing/cli.ts", import.meta.url).href;
  // A real install is megabytes; a launcher this small would not be trusted to name its version.
  const padding = `// ${"x".repeat(80 * 1024)}\n`;
  const install = (version: string | undefined) =>
    writeFile(
      executable,
      `#!${process.execPath}\n${padding}import { appendFileSync } from "node:fs";\n` +
        `if (process.argv.includes("--version")) {\n  appendFileSync(${JSON.stringify(probes)}, "v");\n` +
        (version ? `  console.log("${version} (Claude Code)");\n  process.exit(0);\n` : "") +
        `}\nawait import(${JSON.stringify(fake)});\n`,
    );
  await install(undefined);
  await chmod(executable, 0o755);
  const adapter = createClaudeAdapter({ executable });
  const ctx = {
    threadId: ThreadId.parse("versions"),
    cwd: root,
    signal: new AbortController().signal,
    onFrame() {},
    onExit() {},
  };
  for (let open = 0; open < 2; open++) await (await adapter.openSession(ctx)).close("shutdown");
  expect(await readFile(probes, "utf8")).toBe("v");

  await install("2.1.200");
  await expect(adapter.openSession(ctx)).rejects.toMatchObject({
    code: "cli_too_old",
    installed: "2.1.200",
  });
  expect(await readFile(probes, "utf8")).toBe("vv");
});
