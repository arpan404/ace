import { workspaceRuntime } from "@ace/workspace";
import { createHash } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { expect, test } from "vitest";
import { fixture } from "./test-support.ts";

const digest = createHash("sha256").update("data").digest("hex");
const Upload = z.object({ uploadId: z.string() });
const Stat = z.object({ version: z.string().nullable() });

for (const replacement of [false, true]) {
  test(`a lost ${replacement ? "replacement" : "new"} upload publication reply recovers after restart without retaining quota or deleting bytes`, async () => {
    let now = 1;
    let loseReply = true;
    const runtime = workspaceRuntime();
    const filesystem = runtime.filesystem;
    runtime.filesystem = {
      ...filesystem,
      async realpath(path) {
        const resolved = await filesystem.realpath(path);
        if (
          replacement &&
          loseReply &&
          (await readFile(join(resolved, "final"), "utf8").catch(() => "")) === "data"
        )
          throw new Error("worker lost publication reply");
        return resolved;
      },
    };
    const f = await fixture({
      workspaceRuntime: runtime,
      now: () => now,
      retentionMs: 10,
      maxReservedBytes: 4,
      exclusiveRename: {
        async move(source, destination) {
          await rename(source, destination);
          if (loseReply) throw new Error("worker lost publication reply");
        },
        async close() {},
      },
    });
    try {
      if (replacement) await writeFile(join(f.root, "final"), "old");
      const expected = Stat.parse(
        await f.service.request("writer", { op: "stat", path: "final" }),
      ).version;
      const upload = Upload.parse(
        await f.service.request("writer", { op: "upload.begin", path: "final", expected, size: 4 }),
      );
      await f.service.append("writer", upload.uploadId, 0, Buffer.from("data"));
      await expect(
        f.service.request("writer", {
          op: "upload.commit",
          uploadId: upload.uploadId,
          sha256: digest,
        }),
      ).rejects.toThrow("worker lost");
      loseReply = false;
      await f.restart();
      loseReply = false;
      expect(await readFile(join(f.root, "final"), "utf8")).toBe("data");
      await expect(
        f.service.request("writer", {
          op: "upload.commit",
          uploadId: upload.uploadId,
          sha256: digest,
        }),
      ).resolves.toMatchObject({ path: "final" });
      await expect(
        f.service.request("writer", { op: "upload.resume", uploadId: upload.uploadId }),
      ).rejects.toMatchObject({ code: "COMMITTED" });
      await expect(
        f.service.request("writer", {
          op: "upload.commit",
          uploadId: upload.uploadId,
          sha256: digest,
        }),
      ).resolves.toMatchObject({ path: "final" });
      now = 20;
      await f.service.sweep();
      const current = Stat.parse(
        await f.service.request("writer", { op: "stat", path: "final" }),
      ).version;
      await expect(
        f.service.request("writer", {
          op: "move",
          path: "final",
          destination: "moved",
          destinationExpected: null,
          expected: current,
        }),
      ).resolves.toMatchObject({ path: "final", destination: "moved" });
      expect(await readFile(join(f.root, "moved"), "utf8")).toBe("data");
      await expect(
        f.service.request("writer", { op: "upload.begin", path: "next", expected: null, size: 4 }),
      ).resolves.toMatchObject({ offset: 0 });
      await expect(
        f.service.request("writer", {
          op: "upload.begin",
          path: "over-quota",
          expected: null,
          size: 4,
        }),
      ).rejects.toMatchObject({ code: "QUOTA" });
    } finally {
      await f.close();
    }
  });
}

for (const alteration of ["replace", "relocate", "edit"]) {
  test(`recovery retains uncertain publication debt when the final inode is ${alteration === "edit" ? "edited" : alteration === "replace" ? "replaced" : "relocated"}`, async () => {
    let now = 1;
    const f = await fixture({
      now: () => now,
      retentionMs: 10,
      maxReservedBytes: 4,
      exclusiveRename: {
        async move(source, destination) {
          await rename(source, destination);
          throw new Error("lost");
        },
        async close() {},
      },
    });
    try {
      const upload = Upload.parse(
        await f.service.request("writer", {
          op: "upload.begin",
          path: "final",
          expected: null,
          size: 4,
        }),
      );
      await f.service.append("writer", upload.uploadId, 0, Buffer.from("data"));
      await expect(
        f.service.request("writer", {
          op: "upload.commit",
          uploadId: upload.uploadId,
          sha256: digest,
        }),
      ).rejects.toThrow("lost");
      if (alteration !== "edit") await rename(join(f.root, "final"), join(f.home, "outside"));
      if (alteration !== "relocate") await writeFile(join(f.root, "final"), "safe");
      await f.restart();
      now = 20;
      await f.service.sweep();
      await expect(
        f.service.request("writer", { op: "upload.begin", path: "next", expected: null, size: 4 }),
      ).rejects.toMatchObject({ code: "QUOTA" });
      if (alteration !== "relocate")
        expect(await readFile(join(f.root, "final"), "utf8")).toBe("safe");
      if (alteration !== "edit")
        expect(await readFile(join(f.home, "outside"), "utf8")).toBe("data");
    } finally {
      await f.close();
    }
  });
}

for (const mode of [0o200, 0o000, 0o100]) {
  test(`a replacement publishes mode ${mode.toString(8)} before losing publication completion and recovers without read access`, async () => {
    let lose = true;
    const runtime = workspaceRuntime();
    const filesystem = runtime.filesystem;
    runtime.filesystem = {
      ...filesystem,
      async realpath(path) {
        const resolved = await filesystem.realpath(path);
        const final = await filesystem.lstat(join(resolved, "final")).catch(() => undefined);
        if (lose && final?.size === 4) throw new Error("lost publication completion");
        return resolved;
      },
    };
    const f = await fixture({ workspaceRuntime: runtime, maxReservedBytes: 4 });
    try {
      await writeFile(join(f.root, "final"), "old", { mode });
      const expected = Stat.parse(
        await f.service.request("writer", { op: "stat", path: "final" }),
      ).version;
      const upload = Upload.parse(
        await f.service.request("writer", { op: "upload.begin", path: "final", expected, size: 4 }),
      );
      await f.service.append("writer", upload.uploadId, 0, Buffer.from("data"));
      await expect(
        f.service.request("writer", {
          op: "upload.commit",
          uploadId: upload.uploadId,
          sha256: digest,
        }),
      ).rejects.toThrow("lost publication");
      expect((await filesystem.lstat(join(f.root, "final"))).mode & 0o777).toBe(mode);
      lose = false;
      if (process.getuid?.() !== 0)
        await expect(
          f.service.download("readonly", { op: "download", path: "final" }),
        ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      await f.restart();
      await expect(
        f.service.request("writer", {
          op: "upload.commit",
          uploadId: upload.uploadId,
          sha256: digest,
        }),
      ).resolves.toMatchObject({ path: "final" });
      expect((await filesystem.lstat(join(f.root, "final"))).mode & 0o777).toBe(mode);
      if (process.getuid?.() !== 0)
        await expect(readFile(join(f.root, "final"))).rejects.toMatchObject({ code: "EACCES" });
      const current = Stat.parse(
        await f.service.request("writer", { op: "stat", path: "final" }),
      ).version;
      await expect(
        f.service.request("writer", {
          op: "move",
          path: "final",
          destination: "moved",
          destinationExpected: null,
          expected: current,
        }),
      ).resolves.toMatchObject({ destination: "moved" });
      expect((await filesystem.lstat(join(f.root, "moved"))).mode & 0o777).toBe(mode);
      await expect(
        f.service.request("writer", { op: "upload.begin", path: "next", expected: null, size: 4 }),
      ).resolves.toMatchObject({ offset: 0 });
      await expect(
        f.service.request("writer", { op: "upload.begin", path: "over", expected: null, size: 4 }),
      ).rejects.toMatchObject({ code: "QUOTA" });
      await chmod(join(f.root, "moved"), 0o600);
      expect(await readFile(join(f.root, "moved"), "utf8")).toBe("data");
    } finally {
      lose = false;
      await f.close();
    }
  });
}
