import { rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { GitWorkspace, resolveMentions } from "./index.ts";
import { repository } from "./test-support.ts";

test.each(["src", "src/deep"])(
  "an over-quota %s update and failed rebuild preserve published completion and mentions",
  async (folder) => {
    const repo = await repository();
    const workspace = new GitWorkspace(repo.root, folder.split("/").length + 3);
    try {
      await repo.write("other.ts", "outside");
      await repo.write(`${folder}/z.ts`, "published");
      await workspace.initialize();
      await repo.write(`${folder}/a.ts`, "new a");
      await repo.write(`${folder}/b.ts`, "new b");
      // The subtree fits by itself, but exceeds the cap with other.ts present.
      await expect(workspace.update([folder])).rejects.toMatchObject({ code: "quota" });
      expect(workspace.index.complete("z.ts")).toEqual([`${folder}/z.ts`]);
      expect(workspace.index.complete("other.ts")).toEqual(["other.ts"]);
      expect(workspace.index.complete("a.ts")).toEqual([]);
      expect(workspace.index.complete("b.ts")).toEqual([]);
      expect(
        (await resolveMentions(workspace, [{ path: folder }])).entries.map((entry) => entry.path),
      ).toEqual([`${folder}/z.ts`]);
      await expect(workspace.initialize()).rejects.toMatchObject({ code: "quota" });
      expect(workspace.index.complete("z.ts")).toEqual([`${folder}/z.ts`]);
      expect(workspace.index.complete("a.ts")).toEqual([]);
      await rm(join(repo.root, `${folder}/a.ts`));
      await workspace.update([folder]);
      expect(workspace.index.complete("other.ts")).toEqual(["other.ts"]);
      expect(
        (await resolveMentions(workspace, [{ path: folder }])).entries
          .map((entry) => entry.path)
          .toSorted(),
      ).toEqual([`${folder}/b.ts`, `${folder}/z.ts`]);
    } finally {
      await repo.close();
    }
  },
);
