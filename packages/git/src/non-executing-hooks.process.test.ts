import { access, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { GitService } from "./index.ts";
import { git, repository, scalar } from "./test-repo.ts";
import { quote } from "./credential-test-fixtures.ts";

test("an authorized push never executes repo-configured signing even when the remote advertises push certificates", async () => {
  const repo = await repository();
  const remote = join(dirname(repo), "remote.git");
  const marker = join(dirname(repo), "gpg-executed");
  const signer = join(dirname(repo), "hostile-gpg.sh");
  await scalar(repo, "init", "--bare", remote);
  await scalar(remote, "config", "receive.certNonceSeed", "test-push-certificate-nonce");
  await scalar(repo, "remote", "add", "origin", `file://${remote}`);
  await writeFile(signer, `#!/bin/sh\nprintf executed > ${quote(marker)}\nexit 1\n`, {
    mode: 0o755,
  });
  await scalar(repo, "config", "push.gpgSign", "if-asked");
  await scalar(repo, "config", "gpg.format", "openpgp");
  await scalar(repo, "config", "gpg.program", signer);
  await scalar(repo, "config", "user.signingKey", "test-key");
  // Control: the real local receive-pack advertises a nonce, causing unprotected Git to sign.
  await expect(git(repo, "push", "origin", "HEAD")).rejects.toBeDefined();
  await expect(access(marker)).resolves.toBeUndefined();
  await rm(marker);
  const service = new GitService({
    transportProtocols: ["file"],
    credentialHelperLookup: async () => [],
  });
  service.protectWorktree(repo);
  try {
    await service.push({ worktree: repo, remote: "origin" });
    const branch = await scalar(repo, "symbolic-ref", "--short", "HEAD");
    expect(await scalar(remote, "rev-parse", `refs/heads/${branch}`)).toBe(
      await scalar(repo, "rev-parse", "HEAD"),
    );
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await service.close();
  }
});

async function supportsNamedHooks(repo: string) {
  const marker = join(dirname(repo), "named-hook-probe");
  await scalar(repo, "config", "hook.ace-policy-probe.event", "pre-push");
  await scalar(
    repo,
    "config",
    "hook.ace-policy-probe.command",
    `printf supported > ${quote(marker)}`,
  );
  try {
    await git(
      repo,
      "-c",
      "hook.pre-push.enabled=true",
      "-c",
      "hook.ace-policy-probe.enabled=true",
      "hook",
      "run",
      "pre-push",
    ).catch(() => {});
    return await access(marker).then(
      () => true,
      () => false,
    );
  } finally {
    await scalar(repo, "config", "--remove-section", "hook.ace-policy-probe");
  }
}

test("configured hooks stay disabled during authorized push, protected commit, checkout, merge and worktree cleanup", async (context) => {
  const repo = await repository();
  if (!(await supportsNamedHooks(repo)))
    context.skip("Installed Git does not support configured hooks");
  const initial = await scalar(repo, "rev-parse", "HEAD");
  await scalar(repo, "branch", "checkout-target", initial);
  const remote = join(dirname(repo), "remote.git");
  await scalar(repo, "init", "--bare", remote);
  await scalar(repo, "remote", "add", "origin", `file://${remote}`);
  const marker = join(dirname(repo), "named-hook-executed");
  await scalar(repo, "config", "hook.attack.command", `printf executed > ${quote(marker)}`);
  // Include hooks that --no-verify does not suppress, particularly prepare-commit-msg and
  // post-checkout. The shared policy must protect all operations, not just push admission.
  for (const event of [
    "pre-push",
    "pre-commit",
    "prepare-commit-msg",
    "commit-msg",
    "post-commit",
    "post-checkout",
    "post-merge",
    "reference-transaction",
    "post-index-change",
  ])
    await scalar(repo, "config", "--add", "hook.attack.event", event);
  await scalar(repo, "config", "hook.attack.enabled", "true");
  const service = new GitService({
    transportProtocols: ["file"],
    credentialHelperLookup: async () => [],
  });
  service.protectWorktree(repo);
  try {
    await service.push({ worktree: repo, remote: "origin" });
    await writeFile(join(repo, "tracked.txt"), "Protected commit\n");
    const committed = await service.commit({
      worktree: repo,
      message: "Protected commit",
      expectedHead: initial,
    });
    expect(committed).not.toBe(initial);
    await service.switchBranch({
      worktree: repo,
      branch: "checkout-target",
      allowUncommitted: false,
    });
    expect(await scalar(repo, "rev-parse", "HEAD")).toBe(initial);
    const integrated = await service.integrate({
      worktree: repo,
      revision: committed,
      key: "protected-merge",
    });
    expect(integrated.conflict).toBeNull();
    expect(await scalar(repo, "show", "HEAD:tracked.txt")).toBe("Protected commit");
    await service.nonExecuting(async () => {
      const path = join(dirname(repo), "protected-fork");
      await service.createWorktree({ repo, path, branch: "protected-fork", baseRef: "HEAD" });
      await service.removeWorktree({ repo, path });
      await service.deleteBranch({
        repo,
        branch: "protected-fork",
        expectedHead: integrated.revision,
      });
    });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await service.close();
  }
});
