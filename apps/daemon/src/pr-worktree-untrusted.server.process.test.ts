import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { prDaemon, run } from "./pr-worktree-test-support.ts";

for (const existing of [false, true]) {
  test(`preparing a fork PR for ${existing ? "an existing" : "a new"} task never executes its setup scripts or checkout hooks`, async () => {
    const markers: string[] = [];
    const d = await prDaemon({
      fork: true,
      async content(root, scratch) {
        const script = (kind: string) => {
          const marker = join(scratch, `${kind}-executed`);
          markers.push(marker);
          return `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`;
        };
        await writeFile(join(root, "package-setup.cjs"), script("package"));
        await writeFile(join(root, "make-setup.cjs"), script("make"));
        await writeFile(join(root, "hook.cjs"), script("hook"));
        await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { setup: "node package-setup.cjs" } }));
        await writeFile(join(root, "Makefile"), "setup:\n\tnode make-setup.cjs\n");
        await mkdir(join(root, ".githooks"));
        for (const name of ["post-checkout", "post-index-change", "reference-transaction"])
          await writeFile(join(root, ".githooks", name), "#!/bin/sh\nnode hook.cjs\n", { mode: 0o755 });
      },
      configureGit: async (root) => { await run(root, "config", "core.hooksPath", ".githooks"); },
    });
    try {
      const id = existing ? await d.h.create() : ThreadId.parse("untrusted-fork");
      expect(existing ? await d.work(id, "prepare-untrusted") : await d.create(id)).toMatchObject({ ok: true });
      const thread = d.h.store.getThread(id);
      const path = thread?.details?.worktree ?? "";
      expect(await run(path, "rev-parse", "HEAD")).toBe(d.head);
      expect(await readFile(join(path, "package-setup.cjs"), "utf8")).toContain("writeFileSync");
      expect(await readFile(join(path, ".githooks", "post-checkout"), "utf8")).toContain("node hook.cjs");
      for (const marker of markers) await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await d.close();
    }
  });
}
