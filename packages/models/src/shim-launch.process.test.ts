import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createModelDiscovery, ModelInstance } from "./index.ts";

/** A stand-in mise answering `which codex` with `answer`; run as the shim, it marks that it ran. */
async function codexThroughMise(answer: (installed: string) => string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-shim-models-")));
  const ran = join(root, "ran-as-shim");
  const installed = join(root, "installs/codex");
  const mise = join(root, "bin/mise");
  await mkdir(join(root, "bin"));
  await writeFile(
    mise,
    `#!/bin/sh\nif [ "\${0##*/}" != mise ]; then : > '${ran}'; exit 0; fi\n${answer(installed)}\n`,
    { mode: 0o755 },
  );
  const shims = join(root, "mise/shims");
  await mkdir(shims, { recursive: true });
  await symlink(mise, join(shims, "codex"));
  await mkdir(join(root, "installs"));
  await writeFile(installed, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const instance = ModelInstance.parse({
    id: "codex-cli-default",
    provider: "codex",
    executable: join(shims, "codex"),
    cwd: root,
    env: { PATH: shims },
    loginRevision: "1",
  });
  return { instance, installed, ranAsShim: () => existsSync(ran) };
}

/** Records the command model discovery launches, and launches nothing. */
function recordingDiscovery() {
  const launched: string[] = [];
  const discover = createModelDiscovery({
    spawn: (options) => {
      launched.push(options.command);
      throw new Error("Launch recorded");
    },
  });
  return { discover, launched };
}

test.runIf(process.platform !== "win32")(
  "listing models through a mise shim launches the installed binary, never the shim",
  async () => {
    const f = await codexThroughMise((installed) => `echo '${installed}'`);
    const { discover, launched } = recordingDiscovery();
    await expect(discover(f.instance, new AbortController().signal)).rejects.toThrow(
      "Launch recorded",
    );
    expect(launched).toEqual([f.installed]);
    expect(f.ranAsShim()).toBe(false);
  },
);

test.runIf(process.platform !== "win32")(
  "listing models through a shim for a tool that isn't installed launches nothing",
  async () => {
    const f = await codexThroughMise(
      () => "echo 'mise ERROR codex is a mise bin however it is not currently active.' >&2; exit 1",
    );
    const { discover, launched } = recordingDiscovery();
    await expect(discover(f.instance, new AbortController().signal)).rejects.toThrow(
      "isn't installed",
    );
    expect(launched).toEqual([]);
    expect(f.ranAsShim()).toBe(false);
  },
);

test.runIf(process.platform !== "win32")(
  "listing models resolves the shim for the instance's own directory",
  async () => {
    const f = await codexThroughMise(
      (installed) =>
        `case "$PWD" in */project) echo "$PWD/codex" ;; *) echo '${installed}' ;; esac`,
    );
    const project = join(f.instance.cwd, "project");
    await mkdir(project);
    await writeFile(join(project, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const { discover, launched } = recordingDiscovery();
    await expect(
      discover({ ...f.instance, cwd: project }, new AbortController().signal),
    ).rejects.toThrow("Launch recorded");
    expect(launched).toEqual([join(project, "codex")]);
  },
);
