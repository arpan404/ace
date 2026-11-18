import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { probeOutput } from "../process.ts";
import { discoverProvider, findInstalledExecutable } from "./index.ts";

/**
 * A stand-in mise. Asked `which <tool>`, it answers as `answer` says and records the settings
 * it was given. Run as a shim (by a tool's name), it records that it ran: that's when the real
 * mise installs or updates the tool.
 */
async function fakeMise(answer: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-shim-resolve-")));
  const ranAsShim = join(root, "ran-as-shim");
  const settings = join(root, "settings");
  const mise = join(root, "mise-bin/mise");
  await mkdir(join(root, "mise-bin"));
  await writeFile(
    mise,
    `#!/bin/sh
if [ "\${0##*/}" != mise ]; then : > '${ranAsShim}'; echo 'codex-cli 9.9.9'; exit 0; fi
echo "$MISE_OFFLINE $MISE_AUTO_INSTALL $MISE_EXEC_AUTO_INSTALL $MISE_NOT_FOUND_AUTO_INSTALL" > '${settings}'
${answer}
`,
    { mode: 0o755 },
  );
  const shims = join(root, ".local/share/mise/shims");
  await mkdir(shims, { recursive: true });
  await symlink(mise, join(shims, "codex"));
  // The installed CLI the shim stands for.
  const installed = join(root, ".local/share/mise/installs/codex/1.0/bin/codex");
  await mkdir(join(installed, ".."), { recursive: true });
  await writeFile(
    installed,
    `#!/bin/sh\nif [ "$1" = --version ]; then echo 'codex-cli 0.159.1'; else echo 'Not logged in'; fi\n`,
    { mode: 0o755 },
  );
  return {
    env: { PATH: shims, HOME: root },
    shim: join(shims, "codex"),
    installed,
    ranAsShim: () => existsSync(ranAsShim),
    settings: () => readFileSync(settings, "utf8").trim(),
  };
}

const posix = process.platform !== "win32";

test.runIf(posix)(
  "a mise shim whose tool is installed is probed through the installed binary",
  async () => {
    const f = await fakeMise(`echo "\${0%/*}/../.local/share/mise/installs/codex/1.0/bin/codex"`);
    const result = await discoverProvider("codex", { env: f.env, timeoutMs: 5_000 });
    expect(result).toMatchObject({
      installed: true,
      path: f.shim,
      version: "0.159.1",
      auth: "logged_out",
    });
    expect(f.ranAsShim()).toBe(false);
    // Asked with installing and network access off.
    expect(f.settings()).toBe("1 0 0 0");
  },
);

test.runIf(posix)(
  "a mise shim for a tool that isn't installed shows as not installed",
  async () => {
    const f = await fakeMise(
      "echo 'mise ERROR codex is a mise bin however it is not currently active.' >&2; exit 1",
    );
    const result = await discoverProvider("codex", { env: f.env, timeoutMs: 5_000 });
    expect(result).toMatchObject({ installed: false });
    expect(result.path).toBeUndefined();
    await expect(probeOutput("codex", ["--version"], { env: f.env })).rejects.toThrow(
      "isn't installed",
    );
    expect(f.ranAsShim()).toBe(false);
  },
);

test.runIf(posix)(
  "a shim its manager can't resolve is found but never run, with the reason",
  async () => {
    const f = await fakeMise("echo 'unexpected failure' >&2; exit 2");
    const result = await discoverProvider("codex", { env: f.env, timeoutMs: 5_000 });
    expect(result).toMatchObject({ installed: true, path: f.shim, auth: "unknown" });
    expect(result.version).toBeUndefined();
    expect(result.error).toContain("mise shim");
    await expect(probeOutput("codex", ["--version"], { env: f.env })).rejects.toThrow(
      "couldn't say which binary it runs",
    );
    expect(f.ranAsShim()).toBe(false);
  },
);

test.runIf(posix)("a manager that answers with another shim is refused too", async () => {
  const f = await fakeMise(`echo "\${0%/*}/../.local/share/mise/shims/codex"`);
  await expect(probeOutput("codex", ["--version"], { env: f.env })).rejects.toThrow("another shim");
  expect(f.ranAsShim()).toBe(false);
});

test.runIf(posix)(
  "a shim resolves for the project it will run in, and the probe runs there",
  async () => {
    // mise picks a tool's version from the project's own config: each project has its own.
    const f = await fakeMise(
      `case "$PWD" in */project-a) echo "\${0%/*}/../project-a/codex" ;; *) echo "\${0%/*}/../.local/share/mise/installs/codex/1.0/bin/codex" ;; esac`,
    );
    const project = join(f.env.HOME, "project-a");
    await mkdir(project);
    await writeFile(join(project, "codex"), `#!/bin/sh\necho "codex-cli 0.200.0 in $PWD"\n`, {
      mode: 0o755,
    });
    const resolved = await findInstalledExecutable("codex", f.env, { cwd: project });
    expect(resolved).toEqual({ path: f.shim, run: join(project, "codex") });
    await expect(
      probeOutput("codex", ["--version"], { env: f.env, cwd: project }),
    ).resolves.toMatchObject({ stdout: `codex-cli 0.200.0 in ${project}` });
    // Elsewhere, the same shim stands for the global install.
    expect(await findInstalledExecutable("codex", f.env, { cwd: f.env.HOME })).toEqual({
      path: f.shim,
      run: f.installed,
    });
    expect(f.ranAsShim()).toBe(false);
  },
);
