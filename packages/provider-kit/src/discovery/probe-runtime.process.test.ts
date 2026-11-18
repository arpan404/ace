import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect, test } from "vitest";
import { probeOutput } from "../process.ts";
import { discoverProvider } from "./index.ts";

/**
 * An npm-installed CLI is a script run by `node` from PATH. Here `node` on PATH is a mise shim
 * (the sentinel: it records if it ran, which is when the real mise installs or updates node).
 * `runtime` is what mise answers for `which node`: a shell line, so a test picks installed or
 * not.
 */
async function scriptBehindRuntimeShim(runtime: string, shebang = "#!/usr/bin/env node") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-probe-runtime-")));
  const ranAsShim = join(root, "runtime-shim-ran");
  const mise = join(root, "mise-bin/mise");
  await mkdir(join(root, "mise-bin"));
  await writeFile(
    mise,
    `#!/bin/sh\nif [ "\${0##*/}" != mise ]; then : > '${ranAsShim}'; exec /bin/sh "$@"; fi\n${runtime}\n`,
    { mode: 0o755 },
  );
  const shims = join(root, ".local/share/mise/shims");
  await mkdir(shims, { recursive: true });
  await symlink(mise, join(shims, "node"));
  // The installed node: runs the script, which is plain sh, as node would run JavaScript.
  const node = join(root, ".local/share/mise/installs/node/26/bin/node");
  await mkdir(join(node, ".."), { recursive: true });
  await writeFile(node, '#!/bin/sh\nexec /bin/sh "$@"\n', { mode: 0o755 });
  const bin = join(root, "npm-global/bin");
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, "codex"),
    `${shebang.replace("{shims}", shims)}\necho 'codex-cli 0.159.1'\necho "$MISE_OFFLINE $MISE_AUTO_INSTALL" >&2\n`,
    { mode: 0o755 },
  );
  return {
    env: { PATH: [bin, shims, "/usr/bin", "/bin"].join(delimiter), HOME: root },
    node,
    ranAsShim: () => existsSync(ranAsShim),
  };
}

const posix = process.platform !== "win32";
const installedNode = `echo "\${0%/*}/../.local/share/mise/installs/node/26/bin/node"`;

test.runIf(posix)(
  "a CLI script whose node is a mise shim is probed with the installed node, never the shim",
  async () => {
    const f = await scriptBehindRuntimeShim(installedNode);
    const result = await discoverProvider("codex", { env: f.env, timeoutMs: 5_000 });
    expect(result).toMatchObject({ installed: true, version: "0.159.1" });
    expect(f.ranAsShim()).toBe(false);
  },
);

test.runIf(posix)(
  "a CLI script naming a shim as its interpreter is run by the installed interpreter",
  async () => {
    const f = await scriptBehindRuntimeShim(installedNode, "#!{shims}/node");
    await expect(probeOutput("codex", ["--version"], { env: f.env })).resolves.toMatchObject({
      stdout: "codex-cli 0.159.1",
    });
    expect(f.ranAsShim()).toBe(false);
  },
);

test.runIf(posix)(
  "a CLI script whose runtime isn't installed is not run, so nothing installs it",
  async () => {
    const f = await scriptBehindRuntimeShim(
      "echo 'mise ERROR node is a mise bin however it is not currently active.' >&2; exit 1",
    );
    await expect(probeOutput("codex", ["--version"], { env: f.env })).rejects.toThrow(
      "isn't installed",
    );
    expect(f.ranAsShim()).toBe(false);
  },
);

test.runIf(posix)(
  "every probe runs with the version managers' installing and network access turned off",
  async () => {
    const f = await scriptBehindRuntimeShim(installedNode);
    const output = await probeOutput("codex", ["--version"], { env: f.env });
    expect(output.stderr).toBe("1 0");
  },
);
