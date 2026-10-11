import { workspaceRuntime } from "@ace/workspace";
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
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
