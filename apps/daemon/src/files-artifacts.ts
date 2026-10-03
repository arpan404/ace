import { open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { FileError, createBlobExport, type FilesService } from "@ace/files";
import { z } from "zod";
import type { WorkspaceId } from "@ace/protocol";
import type { Store } from "./store.ts";

/** Local producers publish bounded files; clients address only the resulting registry ID. */
export function daemonArtifacts(
  files: FilesService,
  root: string,
  store: Store,
  workspace: WorkspaceId,
  database: string,
  writeBundle?: (temporary: string) => Promise<void>,
) {
  let active: Promise<unknown> | undefined;
  let closed = false;
  const blobs = createBlobExport();
  const run = async <T>(effect: () => Promise<T>): Promise<T> => {
    if (closed) throw new FileError("CLOSED", "Artifact producer closed");
    if (active) throw new FileError("BUSY", "One artifact export is allowed at a time");
    const pending = effect();
    active = pending;
    try {
      return await pending;
    } finally {
      active = undefined;
    }
  };
  const sourceWorkspace = (threadId: Parameters<Store["getThread"]>[0]) => {
    if (store.getThread(threadId)?.workspaceId !== workspace)
      throw new FileError("FORBIDDEN", "Artifact source belongs to another workspace");
  };
  const publish = async (
    size: number,
    name: string,
    display: string,
    category: "output" | "support",
    write: (temporary: string) => Promise<void>,
    assertAuthorized: () => void,
  ) => {
    const release = files.reserveArtifactExport(size);
    const temporary = join(root, `.export-${name}`);
    let published = false;
    try {
      await write(temporary);
      assertAuthorized();
      await rename(temporary, join(root, name));
      const id = await files.registerArtifact({
        root,
        path: name,
        name: display.slice(0, 256),
        category,
      });
      published = true;
      return id;
    } finally {
      release();
      await rm(temporary, { force: true });
      if (!published) await rm(join(root, name), { force: true });
    }
  };
  return {
    async support(hostId: string) {
      const temporary = join(root, `.support-${randomUUID()}`);
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(
          JSON.stringify(
            {
              hostId,
              node: process.version,
              platform: process.platform,
              architecture: process.arch,
            },
            null,
            2,
          ),
        );
        await file.sync();
        await file.close();
        await rename(temporary, join(root, "daemon-support.json"));
        return await files.registerArtifact({
          root,
          path: "daemon-support.json",
          name: "daemon-support.json",
          category: "support",
          id: "daemon-support",
        });
      } finally {
        await file.close();
        await rm(temporary, { force: true });
      }
    },
    bundle(assertAuthorized: () => void) {
      return run(async () => {
        assertAuthorized();
        if (!writeBundle) throw new FileError("UNSUPPORTED", "Support producer unavailable");
        // Reserve both the capped staged input and its compressed export until publication.
        return publish(
          36 * 1024 ** 2,
          `support-${randomUUID()}.tar.gz`,
          "ace-support.tar.gz",
          "support",
          writeBundle,
          assertAuthorized,
        );
      });
    },
    output(streamId: string, assertAuthorized: () => void) {
      return run(async () => {
        assertAuthorized();
        const info = store.outputInfo(streamId);
        sourceWorkspace(info.threadId);
        return publish(
          info.size,
          `output-${randomUUID()}.bin`,
          `${streamId}.bin`,
          "output",
          async (temporary) => {
            const file = await open(temporary, "wx", 0o600);
            try {
              let offset = 0;
              while (offset < info.size) {
                assertAuthorized();
                const chunk = z
                  .object({ bytes: z.instanceof(Buffer), nextOffset: z.number().int() })
                  .parse(
                    store.readOutputBytes(
                      streamId,
                      offset,
                      Math.min(64 * 1024, info.size - offset),
                    ),
                  );
                if (chunk.nextOffset <= offset || chunk.nextOffset > info.size)
                  throw new FileError("CONFLICT", "Output snapshot changed during export");
                await file.writeFile(chunk.bytes);
                offset = chunk.nextOffset;
              }
              assertAuthorized();
              await file.sync();
            } finally {
              await file.close();
            }
          },
          assertAuthorized,
        );
      });
    },
    raw(blobRef: string, assertAuthorized: () => void) {
      return run(async () => {
        assertAuthorized();
        const info = store.blobInfo(blobRef);
        sourceWorkspace(info.threadId);
        return publish(
          info.size,
          `raw-${randomUUID()}.bin`,
          `${blobRef}.json`,
          "output",
          (temporary) =>
            blobs.export({
              database,
              temporary,
              rowid: info.rowid,
              size: info.size,
              sha256: info.sha256,
            }),
          assertAuthorized,
        );
      });
    },
    async close() {
      closed = true;
      await active?.catch(() => {});
      await blobs.close();
    },
  };
}
