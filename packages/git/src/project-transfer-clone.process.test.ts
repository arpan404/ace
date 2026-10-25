import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { GitService } from "./index.ts";
import { spawnGitProcess } from "./process-runtime.ts";
import { challengeRemote, executableAskpass, quote } from "./credential-test-fixtures.ts";
import { git, scratch } from "./test-repo.ts";

test.each(["transfer", "project"])(
  "a %s clone preserves the configured SSH command and its interaction policy",
  async (kind) => {
    const parent = await scratch();
    const path = join(parent, "target");
    const config = join(parent, "gitconfig");
    const log = join(parent, "ssh.log");
    const ssh = join(parent, "ssh.sh");
    await writeFile(
      ssh,
      `#!/bin/sh
printf '%s\\n' "$@" "$GCM_INTERACTIVE" "$SSH_ASKPASS_REQUIRE" "askpass=$GIT_ASKPASS/$SSH_ASKPASS" > ${quote(log)}
exit 255
`,
      { mode: 0o755 },
    );
    await git(
      parent,
      "config",
      "--file",
      config,
      "core.sshCommand",
      `${quote(ssh)} --personal-option`,
    );
    const service = new GitService({
      processRuntime: {
        spawn: (command, args, options) =>
          spawnGitProcess(command, args, {
            ...options,
            env: { ...options.env, GIT_CONFIG_GLOBAL: config },
          }),
      },
    });
    try {
      await expect(
        service.clone({
          parent,
          path,
          url: "ssh://git@example.invalid/private.git",
          signal: new AbortController().signal,
          progress() {},
          ...(kind === "transfer" ? { transfer: { timeoutMs: 2_000 } } : {}),
        }),
      ).rejects.toMatchObject({ name: "GitError" });
      const output = await readFile(log, "utf8");
      expect(output).toContain("--personal-option\n");
      if (kind === "transfer") {
        expect(output).toContain("BatchMode=yes\n");
        expect(output).toContain("never\nnever\naskpass=/\n");
      } else {
        expect(output).not.toContain("BatchMode=yes");
      }
    } finally {
      await service.close();
    }
  },
);

test("a transfer clone never invokes configured askpass after an HTTP authentication challenge", async () => {
  const origin = await challengeRemote();
  const parent = await scratch();
  const config = join(parent, "gitconfig");
  const askpass = await executableAskpass(parent, "askpass");
  await git(parent, "config", "--file", config, "core.askPass", askpass.path);
  const service = new GitService({
    processRuntime: {
      spawn: (command, args, options) =>
        spawnGitProcess(command, args, {
          ...options,
          env: {
            ...options.env,
            GIT_CONFIG_GLOBAL: config,
            SSH_ASKPASS: options.env?.SSH_ASKPASS ?? askpass.path,
          },
        }),
    },
  });
  try {
    await expect(
      service.clone(
        {
          parent,
          path: join(parent, "target"),
          url: origin.url,
          signal: new AbortController().signal,
          progress() {},
          transfer: { timeoutMs: 2_000 },
        },
        { validateUrl() {}, protocols: ["http"] },
      ),
    ).rejects.toMatchObject({ name: "GitError" });
    expect(origin.requests()).toBeGreaterThan(0);
    expect(origin.authenticated()).toBe(false);
    await expect(readFile(askpass.marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await service.close();
    await origin.close();
  }
});
