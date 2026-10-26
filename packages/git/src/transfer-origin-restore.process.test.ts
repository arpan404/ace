import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { GitService } from "./index.ts";
import { git, repository, scalar, scratch } from "./test-repo.ts";

let service: GitService;
beforeEach(() => {
  service = new GitService();
});
afterEach(() => service.close());

// A repository import has no reason to contact this URL. No listener or credentials are needed.
const origin = "https://example.invalid/private.git";

test.each([true, false])(
  "a bundle restores origin and tracks only a branch known to origin (known=%s)",
  async (known) => {
    const source = await repository();
    if (known) await git(source, "update-ref", "refs/remotes/origin/main", "HEAD");
    const file = join(await scratch(), "source.bundle");
    await service.transfer.createBundle(source, {
      file,
      refs: ["refs/heads/main", ...(known ? ["refs/remotes/origin/main"] : [])],
    });
    const parent = await scratch();
    const path = join(parent, "target");
    await service.transfer.cloneFromBundle({ parent, path, bundle: file, origin, branch: "main" });
    expect(await scalar(path, "remote", "get-url", "origin")).toBe(origin);
    expect(await scalar(path, "rev-parse", "HEAD")).toBe(await scalar(source, "rev-parse", "HEAD"));
    if (known) {
      expect(await scalar(path, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/main");
    } else {
      expect(await scalar(path, "for-each-ref", "--format=%(upstream)", "refs/heads/main")).toBe(
        "",
      );
    }
  },
);

test.each([
  "https://token@example.invalid/private.git",
  "ssh://git:secret@example.invalid/private.git",
])("a bundle refuses credential-bearing origin URLs (%s)", async (url) => {
  const source = await repository();
  const file = join(await scratch(), "source.bundle");
  await service.transfer.createBundle(source, { file, refs: ["refs/heads/main"] });
  const parent = await scratch();
  const path = join(parent, "target");
  await expect(
    service.transfer.cloneFromBundle({ parent, path, bundle: file, origin: url }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});
