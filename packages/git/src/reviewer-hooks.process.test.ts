import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { GitService } from "./index.ts";
import { put, repository, scalar } from "./test-repo.ts";

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

describe.runIf(process.platform === "win32")("Windows pull request checkouts", () => {
  test("hooks the checkout carries are skipped however Windows spells their path", async () => {
    const repo = await repository();
    const marker = join(dirname(repo), "hook-ran");
    const service = new GitService();
    service.protectWorktree(repo);
    try {
      await put(repo, "tracked.txt", "edited\n");
      for (const directory of [join(repo, "scripts"), join(repo, ".husky")]) {
        await mkdir(directory, { recursive: true });
        const script = `#!/bin/sh\necho ran > '${marker.replaceAll("\\", "/")}'\n`;
        await writeFile(
          join(directory, directory.endsWith("scripts") ? "check.sh" : "pre-commit"),
          script,
        );
      }
      await scalar(repo, "config", "hook.lint.event", "pre-commit");
      for (const command of ["scripts\\check.sh", ".\\SCRIPTS\\check.sh", "./scripts/check.sh"]) {
        await scalar(repo, "config", "hook.lint.command", command);
        expect(await service.reviewerHooks(repo)).toBe("skipped");
      }
      await scalar(repo, "config", "--unset", "hook.lint.command");
      await scalar(repo, "config", "core.hooksPath", ".HUSKY");
      expect(await service.reviewerHooks(repo)).toBe("skipped");
      const expectedHead = await scalar(repo, "rev-parse", "HEAD");
      await service.asReviewer(() =>
        service.commit({ worktree: repo, expectedHead, message: "Reviewed" }),
      );
      expect(await exists(marker)).toBe(false);
      // The person's own script outside the checkout still runs.
      await scalar(repo, "config", "--unset", "core.hooksPath");
      await scalar(repo, "config", "hook.lint.command", join(dirname(repo), "own.sh"));
      expect(await service.reviewerHooks(repo)).toBe("run");
    } finally {
      await service.close();
    }
  });
});
