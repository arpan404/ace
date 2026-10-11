import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { ContextOperation } from "@ace/protocol";
import { RemotePublications } from "./remote-publication.ts";
import { remoteTarget } from "./remote-target-test-support.ts";

test.each(["abort", "I/O failure", "replacement owner"])(
  "completed text remains retrievable with an unavailable-files warning after publication %s",
  async (failure) => {
    const f = await remoteTarget();
    await writeFile(join(f.target.h.home, "interrupted.txt"), "Selected bytes");
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const uploads = f.target.daemon.context.uploads;
    const handle = uploads.handle.bind(uploads);
    const boundary = vi.spyOn(uploads, "handle").mockImplementation(async (...args) => {
      if (ContextOperation.parse(args[1]).op === "upload.begin") {
        started.resolve();
        await gate.promise;
        if (failure === "I/O failure") throw new Error("Disk unavailable");
      }
      return handle(...args);
    });
    const controller = new AbortController();
    const publication = f.target.controls.publications.publish(
      f.caller,
      {
        op: "device.task_publish",
        requestId: "publish",
        attachments: [],
        files: ["interrupted.txt"],
      },
      controller.signal,
    );
    // Observe rejection immediately so abort cannot leave an unhandled promise.
    const finished = publication.catch(() => undefined);
    let recovered: RemotePublications | undefined;
    try {
      await started.promise;
      await f.complete("Original answer before interrupted publication");
      if (failure === "replacement owner") {
        // The old producer is still suspended. The new owner sees only durable rows,
        // exactly as after a crash before the publication's finally block.
        recovered = new RemotePublications({
          store: f.target.daemon.store,
          engine: f.target.daemon.engine!,
          hostId: f.hostId,
        });
      } else {
        if (failure === "abort") controller.abort();
        gate.resolve();
        expect((await finished)?.ok).not.toBe(true);
      }
      const expected = {
        ok: true,
        phase: "completed",
        result: "Original answer before interrupted publication",
        artifactsUnavailable: true,
        artifacts: { attachments: [] },
      };
      expect(
        await f.request({
          type: "delegation.remote.status",
          requestId: "recovered",
          taskId: f.task.id,
        }),
      ).toMatchObject(expected);
      expect(
        await f.request({
          type: "delegation.remote.cancel",
          requestId: "cancel-recovered",
          taskId: f.task.id,
        }),
      ).toMatchObject(expected);
      // A stale producer or another owner cannot replace the original terminal answer.
      gate.resolve();
      await finished;
      recovered?.close();
      recovered = new RemotePublications({
        store: f.target.daemon.store,
        engine: f.target.daemon.engine!,
        hostId: f.hostId,
      });
      expect(recovered.outcome(f.task.id)).toMatchObject({
        result: expected.result,
        artifactsUnavailable: true,
      });
    } finally {
      controller.abort();
      gate.resolve();
      await finished;
      recovered?.close();
      boundary.mockRestore();
    }
  },
);
