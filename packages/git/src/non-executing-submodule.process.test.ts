import { access, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { GitService } from "./index.ts";
import { git, repository, scalar } from "./test-repo.ts";
import { quote } from "./credential-test-fixtures.ts";

test("an authorized parent push never recursively signs an initialized submodule's unpushed commit", async () => {
  const repo = await repository();
  const source = await repository({ "nested.txt": "Original nested content\n" });
  const remote = join(dirname(repo), "parent.git"),
    nestedRemote = join(dirname(repo), "nested.git");
  await scalar(repo, "init", "--bare", remote);
  await scalar(repo, "init", "--bare", nestedRemote);
  const nestedBranch = await scalar(source, "symbolic-ref", "--short", "HEAD");
  await scalar(nestedRemote, "symbolic-ref", "HEAD", `refs/heads/${nestedBranch}`);
  await git(source, "push", nestedRemote, "HEAD");
  const publishedNested = await scalar(source, "rev-parse", "HEAD");
  await git(
    repo,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    `file://${nestedRemote}`,
    "nested",
  );
  const nested = join(repo, "nested");
  await scalar(nested, "config", "user.name", "Test");
  await scalar(nested, "config", "user.email", "test@example.invalid");
  await writeFile(join(nested, "nested.txt"), "Unpushed nested content\n");
  await git(nested, "add", "nested.txt");
  await git(nested, "-c", "commit.gpgSign=false", "commit", "-m", "Unpushed nested commit");
  await git(repo, "add", ".gitmodules", "nested");
  await git(repo, "-c", "commit.gpgSign=false", "commit", "-m", "Advance submodule");
  await scalar(repo, "remote", "add", "origin", `file://${remote}`);
  await scalar(repo, "config", "push.recurseSubmodules", "on-demand");
  await scalar(nestedRemote, "config", "receive.certNonceSeed", "nested-signature-test");
  const marker = join(dirname(repo), "nested-gpg-executed"),
    signer = join(dirname(repo), "nested-gpg.sh");
  await writeFile(signer, `#!/bin/sh\nprintf executed > ${quote(marker)}\nexit 1\n`, {
    mode: 0o755,
  });
  await scalar(nested, "config", "push.gpgSign", "if-asked");
  await scalar(nested, "config", "gpg.format", "openpgp");
  await scalar(nested, "config", "gpg.program", signer);
  await scalar(nested, "config", "user.signingKey", "test-key");
  // Control: top-level signing/verification flags do not reach Git's recursive child push.
  await expect(
    git(
      repo,
      "-c",
      "protocol.file.allow=always",
      "push",
      "--signed=false",
      "--no-verify",
      "origin",
      "HEAD",
    ),
  ).rejects.toBeDefined();
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
    expect(await scalar(nestedRemote, "rev-parse", "HEAD")).toBe(publishedNested);
    expect(await scalar(nested, "rev-parse", "HEAD")).not.toBe(publishedNested);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await service.close();
  }
});
