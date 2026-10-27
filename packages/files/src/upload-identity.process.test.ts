import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { expect, test } from "vitest";
import { fixture } from "./test-support.ts";

// Windows: uploads persist Node's file identity and recovery must recognise the same file
// through the workspace after a restart.
const Upload = z.object({ uploadId: z.string() });
const Stat = z.object({ version: z.string().nullable() });
const sha256 = createHash("sha256").update("data").digest("hex");

test.runIf(process.platform === "win32")(
  "Windows uploads whose publication reply was lost publish once after restart, legacy intents included, while an edited file keeps its debt",
  async () => {
    let now = 1;
    let loseReply = true;
    const f = await fixture({
      now: () => now,
      retentionMs: 10,
      maxReservedBytes: 12,
      exclusiveRename: {
        async move(source, destination) {
          await rename(source, destination);
          if (loseReply) throw new Error("worker lost publication reply");
        },
        async close() {},
      },
    });
    const db = new DatabaseSync(join(f.home, "data", "files.sqlite"));
    try {
      const uploads: Record<string, string> = {};
      for (const path of ["final", "legacy", "edited"]) {
        const { uploadId } = Upload.parse(
          await f.service.request("writer", { op: "upload.begin", path, expected: null, size: 4 }),
        );
        uploads[path] = uploadId;
        await f.service.append("writer", uploadId, 0, Buffer.from("data"));
        await expect(
          f.service.request("writer", { op: "upload.commit", uploadId, sha256 }),
        ).rejects.toThrow("worker lost");
      }
      // An intent written before metadata attestation takes the legacy hashing path.
      db.prepare(
        "UPDATE resources SET body = json_remove(body, '$.verified') WHERE id = ? AND kind = 'upload'",
      ).run(uploads.legacy ?? "");
      await writeFile(join(f.root, "edited"), "safe");
      loseReply = false;
      await f.restart();
      for (const path of ["final", "legacy"]) {
        await expect(
          f.service.request("writer", {
            op: "upload.commit",
            uploadId: uploads[path] ?? "",
            sha256,
          }),
        ).resolves.toMatchObject({ path });
        expect(await readFile(join(f.root, path), "utf8")).toBe("data");
      }
      now = 20;
      await f.service.sweep();
      expect(await readFile(join(f.root, "edited"), "utf8")).toBe("safe");
      await expect(
        f.service.request("writer", { op: "upload.begin", path: "next", expected: null, size: 8 }),
      ).resolves.toMatchObject({ offset: 0 });
      await expect(
        f.service.request("writer", { op: "upload.begin", path: "over", expected: null, size: 1 }),
      ).rejects.toMatchObject({ code: "QUOTA" });
    } finally {
      db.close();
      await f.close();
    }
  },
);

test.runIf(process.platform === "win32")(
  "a Windows replacement resumes acknowledged bytes after an interrupted intent and restart",
  async () => {
    const f = await fixture({ maxReservedBytes: 4 });
    const db = new DatabaseSync(join(f.home, "data", "files.sqlite"));
    try {
      const final = join(f.root, "final");
      await writeFile(final, "old");
      const expected = Stat.parse(
        await f.service.request("writer", { op: "stat", path: "final" }),
      ).version;
      const upload = Upload.parse(
        await f.service.request("writer", { op: "upload.begin", path: "final", expected, size: 4 }),
      );
      await f.service.append("writer", upload.uploadId, 0, Buffer.from("data"));
      db.exec(`CREATE TRIGGER lose_preparation BEFORE UPDATE ON resources
        WHEN OLD.kind='upload' AND json_type(NEW.body,'$.publishing')='text'
        BEGIN SELECT RAISE(ABORT,'lost upload preparation'); END`);
      await expect(
        f.service.request("writer", { op: "upload.commit", uploadId: upload.uploadId, sha256 }),
      ).rejects.toThrow("lost upload preparation");
      db.exec("DROP TRIGGER lose_preparation");
      await f.restart();
      await expect(
        f.service.request("writer", { op: "upload.resume", uploadId: upload.uploadId }),
      ).resolves.toMatchObject({ offset: 4, size: 4 });
      await expect(
        f.service.request("writer", { op: "upload.commit", uploadId: upload.uploadId, sha256 }),
      ).resolves.toMatchObject({ path: "final" });
      expect(await readFile(final, "utf8")).toBe("data");
      await f.restart();
      await expect(
        f.service.request("writer", { op: "upload.commit", uploadId: upload.uploadId, sha256 }),
      ).resolves.toMatchObject({ path: "final" });
      await expect(
        f.service.request("writer", { op: "upload.begin", path: "next", expected: null, size: 4 }),
      ).resolves.toMatchObject({ offset: 0 });
    } finally {
      db.close();
      await f.close();
    }
  },
);
