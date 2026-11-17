import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { probeOutput } from "../process.ts";
import { discoverProvider, versionManagerShim } from "./index.ts";

test.each([
  ["/home/p/.local/share/mise/shims/claude", "/usr/bin/mise", "mise"],
  ["/home/p/.local/share/mise/command-wrappers/bin/codex", "/usr/bin/mise", "mise"],
  ["/opt/tools/claude", "/home/p/.cargo/bin/rtx", "mise"],
  ["/home/p/.asdf/shims/codex", "/home/p/.asdf/shims/codex", "asdf"],
  ["/home/p/.volta/bin/codex", "/home/p/.volta/bin/volta-shim", "volta"],
  ["/home/p/.proto/shims/node", "/home/p/.proto/shims/node", "proto"],
  ["C:\\Users\\p\\.proto\\shims\\node.exe", "C:\\Users\\p\\.proto\\bin\\proto-shim.exe", "proto"],
] as const)("%s is recognized as a %s shim without running it", (path, target, manager) => {
  expect(versionManagerShim(path, target)).toBe(manager);
});

test.each([
  ["/home/p/.local/share/mise/installs/claude/latest/claude"],
  ["/usr/bin/codex"],
  ["/home/p/.local/bin/claude"],
  ["/home/p/shims-notes/codex"],
])("%s is an installed CLI, not a shim", (path) => {
  expect(versionManagerShim(path, path)).toBeUndefined();
});

test.runIf(process.platform !== "win32")(
  "a provider CLI that is a version manager's shim is found but never run to probe it",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ace-shim-probe-")));
    const ran = join(root, "ran");
    // Stands in for mise: running it at all is what installs or updates a tool.
    const mise = join(root, "mise");
    await writeFile(mise, `#!/bin/sh\n: > '${ran}'\necho 'codex-cli 0.159.1'\n`, {
      mode: 0o755,
    });
    const shims = join(root, ".local/share/mise/shims");
    await mkdir(shims, { recursive: true });
    await symlink(mise, join(shims, "codex"));
    const env = { PATH: shims, HOME: root };

    const result = await discoverProvider("codex", { env, timeoutMs: 5_000 });
    expect(result).toMatchObject({ installed: true, path: join(shims, "codex"), auth: "unknown" });
    expect(result.version).toBeUndefined();
    expect(result.error).toContain("mise shim");
    await expect(probeOutput("codex", ["--version"], { env })).rejects.toThrow("mise shim");
    expect(existsSync(ran)).toBe(false);

    // The same program installed as codex itself is probed as usual.
    const installed = join(root, "bin/codex");
    await mkdir(join(root, "bin"));
    await copyFile(mise, installed);
    await expect(
      discoverProvider("codex", { env: { ...env, PATH: join(root, "bin") }, timeoutMs: 5_000 }),
    ).resolves.toMatchObject({ installed: true, version: "0.159.1" });
    expect(existsSync(ran)).toBe(true);
  },
);
