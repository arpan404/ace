import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FilesService } from "@ace/files";
import { ContextOperation } from "@ace/protocol";
import { expect, test, vi } from "vitest";
import { remoteTarget } from "./remote-target-test-support.ts";

const boundaries = [
  "upload.begin",
  "upload.chunk",
  "upload.commit",
  "upload.cancel",
  "download.chunks",
  "download.close",
] as const;

test.each(
  boundaries.flatMap((boundary) => [
    { boundary, completion: "before abort" },
    { boundary, completion: "after abort" },
  ]),
)(
  "publication completed $completion returns its answer while aborted $boundary remains suspended",
  async ({ boundary, completion }) => {
    const f = await remoteTarget();
    await writeFile(join(f.target.h.home, "suspended.txt"), "Selected bytes");
    const suspended = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const pause = async () => {
      suspended.resolve();
      await release.promise;
    };
    const uploads = f.target.daemon.context.uploads;
    const handle = uploads.handle.bind(uploads);
    const upload = vi.spyOn(uploads, "handle").mockImplementation(async (...args) => {
      const operation = ContextOperation.parse(args[1]);
      if (operation.op === boundary) await pause();
      if (boundary === "upload.cancel" && operation.op === "upload.commit")
        throw new Error("Commit failed; upload cleanup still pending");
      return handle(...args);
    });
    const download = FilesService.prototype.download;
    const files = vi.spyOn(FilesService.prototype, "download").mockImplementation(async function (
      this: FilesService,
      ...args
    ) {
      const selected = await download.apply(this, args);
      if (boundary === "download.chunks") {
        const chunks = selected.chunks;
        selected.chunks = (async function* () {
          await pause();
          yield* chunks;
        })();
      }
      if (boundary === "download.close") {
        const close = selected.close;
        selected.close = async () => {
          await pause();
          await close();
        };
      }
      return selected;
    });
    const controller = new AbortController();
    let unwound = false;
    const publication = f.target.controls.publications
      .publish(
        f.caller,
        {
          op: "device.task_publish",
          requestId: "suspended-publication",
          files: ["suspended.txt"],
          attachments: [],
        },
        controller.signal,
      )
      .catch(() => undefined)
      .finally(() => {
        unwound = true;
      });
    try {
      await suspended.promise;
      if (completion === "before abort") await f.complete("Answer preserved across abort");
      controller.abort();
      if (completion === "after abort") await f.complete("Answer preserved across abort");
      const expected = {
        ok: true,
        phase: "completed",
        result: "Answer preserved across abort",
        artifactsUnavailable: true,
        artifacts: { attachments: [] },
      };
      for (const type of ["delegation.remote.status", "delegation.remote.cancel"] as const)
        expect(await f.request({ type, requestId: type, taskId: f.task.id })).toMatchObject(
          expected,
        );
      // These responses must precede both producer unwinding and cleanup completion.
      expect(unwound).toBe(false);
      release.resolve();
      await publication;
      expect(
        await f.request({
          type: "delegation.remote.status",
          requestId: "after-stale-producer",
          taskId: f.task.id,
        }),
      ).toMatchObject(expected);
    } finally {
      controller.abort();
      release.resolve();
      await publication;
      upload.mockRestore();
      files.mockRestore();
    }
  },
);
