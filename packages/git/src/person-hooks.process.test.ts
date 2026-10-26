import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { GitService } from "./index.ts";
import { git, put, repository, scalar } from "./test-repo.ts";
import { quote } from "./credential-test-fixtures.ts";

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** A hook that leaves `marker` behind and exits with `code`. */
async function hook(directory: string, name: string, marker: string, code = 0) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, name),
    `#!/bin/sh\nprintf ran > ${quote(marker)}\nexit ${code}\n`,
    {
      mode: 0o755,
    },
  );
}

/** A protected checkout: an agent's worktree, as the daemon registers it. */
async function protectedCheckout() {
  const repo = await repository();
  const service = new GitService({ transportProtocols: ["file"] });
  service.protectWorktree(repo);
  return { repo, service, marker: join(dirname(repo), "hook-ran") };
}

test("a person's commit in an agent's protected worktree runs their pre-commit hook", async () => {
  const { repo, service, marker } = await protectedCheckout();
  try {
    await hook(join(repo, ".git", "hooks"), "pre-commit", marker);
    await put(repo, "tracked.txt", "edited\n");
    const expectedHead = await scalar(repo, "rev-parse", "HEAD");
    const head = await service.asPerson(() =>
      service.commit({ worktree: repo, expectedHead, message: "Mine" }),
    );
    expect(head).toBe(await scalar(repo, "rev-parse", "HEAD"));
    expect(await exists(marker)).toBe(true);
  } finally {
    await service.close();
  }
});

test("a person's failing pre-commit hook in a protected worktree refuses the commit as a hook failure", async () => {
  const { repo, service, marker } = await protectedCheckout();
  try {
    await hook(join(repo, ".git", "hooks"), "pre-commit", marker, 1);
    await put(repo, "tracked.txt", "edited\n");
    const expectedHead = await scalar(repo, "rev-parse", "HEAD");
    await expect(
      service.asPerson(() => service.commit({ worktree: repo, expectedHead, message: "Mine" })),
    ).rejects.toMatchObject({ code: "hook_failed" });
    expect(await scalar(repo, "rev-parse", "HEAD")).toBe(expectedHead);
  } finally {
    await service.close();
  }
});

test("a person's commit is signed by their configured signer; an automatic one in the same checkout is not", async () => {
  const { repo, service, marker } = await protectedCheckout();
  try {
    const signer = join(dirname(repo), "fake-gpg.sh");
    await writeFile(
      signer,
      [
        "#!/bin/sh",
        `printf signed > ${quote(marker)}`,
        "cat > /dev/null",
        "echo '[GNUPG:] SIG_CREATED D 1 8 00 1700000000 FAKE' >&2",
        "printf -- '-----BEGIN PGP SIGNATURE-----\\n\\nZmFrZQ==\\n-----END PGP SIGNATURE-----\\n'",
      ].join("\n") + "\n",
      { mode: 0o755 },
    );
    await scalar(repo, "config", "commit.gpgSign", "true");
    await scalar(repo, "config", "gpg.program", signer);
    await scalar(repo, "config", "user.signingKey", "FAKE");
    await put(repo, "tracked.txt", "agent\n");
    const automatic = await service.commit({
      worktree: repo,
      expectedHead: await scalar(repo, "rev-parse", "HEAD"),
      message: "Automatic",
    });
    expect(await scalar(repo, "cat-file", "commit", automatic)).not.toContain("gpgsig");
    expect(await exists(marker)).toBe(false);
    await put(repo, "tracked.txt", "person\n");
    const signed = await service.asPerson(() =>
      service.commit({ worktree: repo, expectedHead: automatic, message: "Signed" }),
    );
    expect(await scalar(repo, "cat-file", "commit", signed)).toContain("gpgsig");
    expect(await exists(marker)).toBe(true);
  } finally {
    await service.close();
  }
});

test("automatic work nested in a person's operation still runs no hooks", async () => {
  const { repo, service, marker } = await protectedCheckout();
  try {
    await hook(join(repo, ".git", "hooks"), "pre-commit", marker);
    await put(repo, "tracked.txt", "edited\n");
    const expectedHead = await scalar(repo, "rev-parse", "HEAD");
    await service.asPerson(() =>
      service.nonExecuting(() =>
        service.commit({ worktree: repo, expectedHead, message: "Automatic" }),
      ),
    );
    expect(await exists(marker)).toBe(false);
  } finally {
    await service.close();
  }
});

test("a person's push runs their pre-push hook; an automatic push skips it", async () => {
  const { repo, service, marker } = await protectedCheckout();
  try {
    const remote = join(dirname(repo), "remote.git");
    await git(repo, "init", "--bare", remote);
    await git(repo, "remote", "add", "origin", remote);
    await hook(join(repo, ".git", "hooks"), "pre-push", marker);
    await service.push({ worktree: repo, remote: "origin" });
    expect(await exists(marker)).toBe(false);
    await service.asPerson(() => service.push({ worktree: repo, remote: "origin" }));
    expect(await exists(marker)).toBe(true);
  } finally {
    await service.close();
  }
});

test("in a pull request checkout, hooks inside it are the author's and are skipped; the person's own run", async () => {
  const { repo, service, marker } = await protectedCheckout();
  try {
    await put(repo, "tracked.txt", "edited\n");
    // A PR author's `.husky` directory, selected by a relative hooks path.
    await hook(join(repo, ".husky"), "pre-commit", marker);
    await scalar(repo, "config", "core.hooksPath", ".husky");
    expect(await service.reviewerHooks(repo)).toBe("skipped");
    const expectedHead = await scalar(repo, "rev-parse", "HEAD");
    const first = await service.asReviewer(() =>
      service.commit({ worktree: repo, expectedHead, message: "Reviewed" }),
    );
    expect(await exists(marker)).toBe(false);
    const own = join(dirname(repo), "my-hooks");
    await hook(own, "pre-commit", marker);
    await scalar(repo, "config", "core.hooksPath", own);
    expect(await service.reviewerHooks(repo)).toBe("run");
    await put(repo, "tracked.txt", "again\n");
    await service.asReviewer(() =>
      service.commit({ worktree: repo, expectedHead: first, message: "Again" }),
    );
    expect(await exists(marker)).toBe(true);
  } finally {
    await service.close();
  }
});

test("in a pull request checkout, a configured hook command naming a file in it is skipped too", async () => {
  const { repo, service, marker } = await protectedCheckout();
  try {
    await put(repo, "tracked.txt", "edited\n");
    // A named hook in the person's config whose program is a script the PR carries.
    await hook(join(repo, "scripts"), "check.sh", marker);
    await scalar(repo, "config", "hook.lint.event", "pre-commit");
    await scalar(repo, "config", "hook.lint.command", "./scripts/check.sh");
    expect(await service.reviewerHooks(repo)).toBe("skipped");
    const expectedHead = await scalar(repo, "rev-parse", "HEAD");
    await service.asReviewer(() =>
      service.commit({ worktree: repo, expectedHead, message: "Reviewed" }),
    );
    expect(await exists(marker)).toBe(false);
    // The same hook pointing at the person's own script outside the checkout runs.
    const own = join(dirname(repo), "own-hooks");
    await hook(own, "check.sh", marker);
    await scalar(repo, "config", "hook.lint.command", join(own, "check.sh"));
    expect(await service.reviewerHooks(repo)).toBe("run");
  } finally {
    await service.close();
  }
});
