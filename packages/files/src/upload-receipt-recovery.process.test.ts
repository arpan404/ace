import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { createHash } from "node:crypto";
import { chmod, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { expect, test } from "vitest";
import { fixture } from "./test-support.ts";

const Upload = z.object({ uploadId: z.string() });
const Stat = z.object({ version: z.string().nullable() });
const sha256 = createHash("sha256").update("data").digest("hex");

for (const restart of [false, true]) {
  for (const alteration of ["missing", "moved", "replaced", "permissions"] as const) {
    test(`a pending receipt with a ${alteration} destination settles without blocking ${restart ? "startup" : "other uploads"}`, async () => {
      let now = 1;
      const notices: { uploadId: string; path: string; reason: string }[] = [];
      const f = await fixture({
        now: () => now,
        maxReservedBytes: 8,
        retentionMs: 10,
        onUploadRecovery: (notice) => notices.push(notice),
      });
      const db = new DatabaseSync(join(f.home, "data", "files.sqlite"));
      try {
        const final = join(f.root, "final");
        await writeFile(final, "old", { mode: 0o200 });
        const expected = Stat.parse(
          await f.service.request("writer", { op: "stat", path: "final" }),
        ).version;
        const first = Upload.parse(
          await f.service.request("writer", {
            op: "upload.begin",
            path: "final",
            expected,
            size: 4,
          }),
        );
        const other = Upload.parse(
          await f.service.request("writer", {
            op: "upload.begin",
            path: "other",
            expected: null,
            size: 4,
          }),
        );
        await f.service.append("writer", first.uploadId, 0, Buffer.from("data"));
        // Lose only the receipt's final settlement write, after durable completion.
        db.exec(`CREATE TRIGGER lose_permission_settlement BEFORE UPDATE ON resources
          WHEN OLD.kind='upload.completed' AND json_type(OLD.body,'$.permissions')='object'
          AND json_type(NEW.body,'$.permissions') IS NULL
          BEGIN SELECT RAISE(ABORT,'lost permission settlement'); END`);
        await expect(
          f.service.request("writer", { op: "upload.commit", uploadId: first.uploadId, sha256 }),
        ).rejects.toThrow("lost permission settlement");
        db.exec("DROP TRIGGER lose_permission_settlement");
        if (alteration === "missing") await rm(final);
        if (alteration === "moved" || alteration === "replaced")
          await rename(final, join(f.root, "saved"));
        if (alteration === "replaced") await writeFile(final, "unrelated", { mode: 0o400 });
        if (alteration === "permissions") await chmod(final, 0o400);
        if (restart) await f.restart();
        await expect(
          f.service.request("writer", { op: "upload.resume", uploadId: other.uploadId }),
        ).resolves.toMatchObject({ offset: 0 });
        await f.service.append("writer", other.uploadId, 0, Buffer.from("data"));
        await expect(
          f.service.request("writer", { op: "upload.commit", uploadId: other.uploadId, sha256 }),
        ).resolves.toMatchObject({ path: "other" });
        await expect(
          f.service.request("writer", {
            op: "upload.begin",
            path: "next",
            expected: null,
            size: 8,
          }),
        ).resolves.toMatchObject({ offset: 0 });
        await expect(
          f.service.request("writer", { op: "upload.commit", uploadId: first.uploadId, sha256 }),
        ).resolves.toMatchObject({ path: "final" });
        expect(notices).toContainEqual({
          uploadId: first.uploadId,
          path: "final",
          reason:
            alteration === "missing" || alteration === "moved"
              ? "NOT_FOUND"
              : "destination_changed",
        });
        if (alteration === "replaced") {
          expect(await readFile(final, "utf8")).toBe("unrelated");
          expect((await lstat(final)).mode & 0o777).toBe(0o400);
        }
        if (alteration === "permissions") {
          expect(await readFile(final, "utf8")).toBe("data");
          expect((await lstat(final)).mode & 0o777).toBe(0o400);
        }
        if (alteration === "moved" || alteration === "replaced") {
          expect((await lstat(join(f.root, "saved"))).mode & 0o777).toBe(0o200);
          await chmod(join(f.root, "saved"), 0o600);
          expect(await readFile(join(f.root, "saved"), "utf8")).toBe("data");
        }
        now = 86400_020;
        await f.service.sweep();
        await expect(
          f.service.request("writer", { op: "upload.commit", uploadId: first.uploadId, sha256 }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(await readFile(join(f.root, "other"), "utf8")).toBe("data");
      } finally {
        db.close();
        await f.close();
      }
    });
  }
}
