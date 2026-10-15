import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { GitService } from "./index.ts";
import { spawnGitProcess } from "./process-runtime.ts";
import { git, repository } from "./test-repo.ts";
import { quote } from "./credential-test-fixtures.ts";

test("a push uses a core.sshCommand set only in the system config, in batch mode", async () => {
  const repo = await repository();
  const home = dirname(repo);
  const log = join(home, "system-ssh.log");
  const ssh = join(home, "system-ssh.sh");
  await writeFile(ssh, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${quote(log)}\nexit 255\n`, {
    mode: 0o755,
  });
  // The system file sets an SSH command and no credential helper at all.
  const system = join(home, "system-gitconfig");
  await writeFile(system, `[core]\n\tsshCommand = ${quote(ssh).replaceAll('"', '\\"')}\n`);
  const global = join(home, "empty-global");
  await writeFile(global, "");
  await git(repo, "remote", "add", "origin", "ssh://git@example.invalid/octo/ace.git");
  const service = new GitService({
    // The system file is located through Git itself, as on a real machine.
    credentialConfigPaths: { global, xdg: join(home, "absent-xdg") },
    processRuntime: {
      spawn: (command, args, options) =>
        spawnGitProcess(command, args, {
          ...options,
          env: { ...options.env, GIT_CONFIG_SYSTEM: system },
        }),
    },
  });
  try {
    await expect(service.push({ worktree: repo, remote: "origin" })).rejects.toMatchObject({
      name: "GitError",
    });
    const argv = await readFile(log, "utf8");
    expect(argv).toContain("BatchMode=yes");
    expect(argv).toContain("example.invalid");
  } finally {
    await service.close();
  }
});
