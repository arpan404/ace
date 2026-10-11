import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { readFile, rename, access } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fixture } from "./test-support.ts";

test.each(["busy", "rollback"] as const)(
  "acceptance can retry its reviewed payload after a registry %s failure and reopen",
  async (failure) => {
    const f = await fixture();
    const db = new DatabaseSync(join(f.managerRoot, "registry.sqlite"));
    try {
      const review = await f.prepare();
      if (failure === "busy") db.exec("BEGIN IMMEDIATE");
      else
        db.exec(
          "CREATE TRIGGER reject_install BEFORE INSERT ON installs BEGIN SELECT RAISE(ABORT, 'injected publication failure'); END",
        );
      await expect(f.manager.accept(review)).rejects.toThrow(
        failure === "busy" ? "locked" : "injected publication failure",
      );
      expect(f.manager.pending()).toEqual([review]);
      expect(f.manager.list()).toEqual([]);
      if (failure === "busy") db.exec("ROLLBACK");
      else db.exec("DROP TRIGGER reject_install");
      await f.reopen();
      const install = await f.manager.accept(review);
      expect(install).toMatchObject({ hash: review.hash, commit: review.commit });
      expect(f.manager.list()).toEqual([install]);
      expect(f.manager.pending()).toEqual([]);
      expect(
        await readFile(join(f.managerRoot, "versions", install.hash, "rules/style.md"), "utf8"),
      ).toBe("Use TypeScript.");
      await f.reopen();
      expect(f.manager.list()).toEqual([install]);
    } finally {
      db.close();
      await f.close();
    }
  },
);

test("startup retains a promoted pending review, validates its bytes, and cancellation collects them", async () => {
  const f = await fixture();
  try {
    const review = await f.prepare();
    const promoted = join(f.managerRoot, "versions", review.hash);
    await rename(join(f.managerRoot, "staging", review.id), promoted);
    await f.reopen();
    await expect(f.manager.accept({ ...review, commit: "0".repeat(40) })).rejects.toThrow(
      "Consent",
    );
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(promoted, "rules/style.md"), "Tampered");
    await expect(f.manager.accept(review)).rejects.toThrow("Integrity");
    expect(f.manager.list()).toEqual([]);
    await f.manager.cancel(review.id);
    await expect(access(promoted)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.manager.pending()).toEqual([]);
  } finally {
    await f.close();
  }
});
