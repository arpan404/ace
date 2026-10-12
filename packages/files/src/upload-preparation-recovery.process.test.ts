import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { workspaceRuntime } from "@ace/workspace";
import { createHash } from "node:crypto";
import { chmod, link, lstat, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { expect, test } from "vitest";
import { fixture } from "./test-support.ts";

const Upload = z.object({ uploadId: z.string() });
const Stat = z.object({ version: z.string().nullable() });
const sha256 = createHash("sha256").update("data").digest("hex");

for (const restart of [false, true]) {
  for (const mode of [0o000, 0o200, 0o100]) {
    for (const fault of ["intent", "prepared"] as const) {
      test(`a mode ${mode.toString(8)} replacement resumes acknowledged bytes after interrupted ${fault}${restart ? " and restart" : " in the running service"}`, async () => {
        let temp: string | undefined;
        let lose = true;
        const runtime = workspaceRuntime();
        const filesystem = runtime.filesystem;
        runtime.filesystem = {
          ...filesystem,
          async realpath(path) {
            const resolved = await filesystem.realpath(path);
            if (fault === "prepared" && lose && temp && ((await lstat(temp)).mode & 0o777) === mode)
              throw new Error("lost upload preparation");
            return resolved;
          },
        };
        const f = await fixture({ workspaceRuntime: runtime, maxReservedBytes: 4 });
        const db = new DatabaseSync(join(f.home, "data", "files.sqlite"));
        try {
          const final = join(f.root, "final");
          await writeFile(final, "old", { mode });
          const original = await lstat(final);
          const expected = Stat.parse(
            await f.service.request("writer", { op: "stat", path: "final" }),
          ).version;
          const upload = Upload.parse(
            await f.service.request("writer", {
              op: "upload.begin",
              path: "final",
              expected,
              size: 4,
            }),
          );
          temp = join(f.root, `.ace-upload-${upload.uploadId}`);
          await expect(
            f.service.append("writer", upload.uploadId, 0, Buffer.from("data")),
          ).resolves.toMatchObject({ offset: 4 });
          if (fault === "intent")
            db.exec(`CREATE TRIGGER lose_preparation BEFORE UPDATE ON resources
          WHEN OLD.kind='upload' AND json_type(NEW.body,'$.publishing')='text'
          BEGIN SELECT RAISE(ABORT,'lost upload preparation'); END`);
          await expect(
            f.service.request("writer", { op: "upload.commit", uploadId: upload.uploadId, sha256 }),
          ).rejects.toThrow("lost upload preparation");
          if (fault === "intent") db.exec("DROP TRIGGER lose_preparation");
          lose = false;
          expect((await lstat(final)).ino).toBe(original.ino);
          expect((await lstat(final)).mode & 0o777).toBe(mode);
          if (fault === "prepared") expect((await lstat(temp)).mode & 0o777).toBe(mode);
          if (restart) await f.restart();
          await expect(
            f.service.request("writer", { op: "upload.resume", uploadId: upload.uploadId }),
          ).resolves.toMatchObject({ offset: 4, size: 4 });
          expect((await lstat(temp)).mode & 0o777).toBe(0o600);
          expect(await readFile(temp, "utf8")).toBe("data");
          await expect(
            f.service.request("writer", { op: "upload.commit", uploadId: upload.uploadId, sha256 }),
          ).resolves.toMatchObject({ path: "final" });
          expect((await lstat(final)).mode & 0o777).toBe(mode);
          await f.restart();
          await expect(
            f.service.request("writer", { op: "upload.commit", uploadId: upload.uploadId, sha256 }),
          ).resolves.toMatchObject({ path: "final" });
          await expect(
            f.service.request("writer", {
              op: "upload.begin",
              path: "next",
              expected: null,
              size: 4,
            }),
          ).resolves.toMatchObject({ offset: 0 });
          await chmod(final, 0o600);
          expect(await readFile(final, "utf8")).toBe("data");
        } finally {
          lose = false;
          db.close();
          await f.close();
        }
      });
    }
  }
}

for (const replacement of ["file", "symlink", "hardlink"] as const) {
  test(`unpublished permission recovery leaves a replacement ${replacement} untouched`, async () => {
    let temp: string | undefined;
    let lose = true;
    const runtime = workspaceRuntime();
    const filesystem = runtime.filesystem;
    runtime.filesystem = {
      ...filesystem,
      async realpath(path) {
        const resolved = await filesystem.realpath(path);
        if (lose && temp && ((await lstat(temp)).mode & 0o777) === 0)
          throw new Error("lost preparation");
        return resolved;
      },
    };
    const f = await fixture({ workspaceRuntime: runtime, maxReservedBytes: 8 });
    try {
      const final = join(f.root, "final");
      await writeFile(final, "old", { mode: 0 });
      const expected = Stat.parse(
        await f.service.request("writer", { op: "stat", path: "final" }),
      ).version;
      const upload = Upload.parse(
        await f.service.request("writer", { op: "upload.begin", path: "final", expected, size: 4 }),
      );
      temp = join(f.root, `.ace-upload-${upload.uploadId}`);
      await f.service.append("writer", upload.uploadId, 0, Buffer.from("data"));
      await expect(
        f.service.request("writer", { op: "upload.commit", uploadId: upload.uploadId, sha256 }),
      ).rejects.toThrow("lost preparation");
      lose = false;
      await rename(temp, join(f.home, "owned-original"));
      const unrelated = replacement === "file" ? temp : join(f.home, "unrelated");
      if (replacement === "hardlink") await link(join(f.home, "owned-original"), temp);
      else await writeFile(unrelated, "safe", { mode: 0o400 });
      if (replacement === "symlink") await symlink(unrelated, temp);
      await f.restart();
      if (replacement !== "hardlink") {
        expect((await lstat(unrelated)).mode & 0o777).toBe(0o400);
        expect(await readFile(unrelated, "utf8")).toBe("safe");
      }
      expect((await lstat(join(f.home, "owned-original"))).mode & 0o777).toBe(0);
      if (replacement !== "hardlink" || process.getuid?.() !== 0)
        await expect(
          f.service.request("writer", { op: "upload.resume", uploadId: upload.uploadId }),
        ).rejects.toBeInstanceOf(Error);
      await expect(
        f.service.request("writer", { op: "upload.begin", path: "other", expected: null, size: 4 }),
      ).resolves.toMatchObject({ offset: 0 });
      await expect(
        f.service.request("writer", { op: "upload.begin", path: "over", expected: null, size: 1 }),
      ).rejects.toMatchObject({ code: "QUOTA" });
    } finally {
      lose = false;
      await f.close();
    }
  });
}
