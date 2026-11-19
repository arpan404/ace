import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { nodeFilesHost } from "@ace/files-native";
import { fakeFilesScript, ManualClock, settle, trackingHost } from "@ace/files-native/test-support";
import { ThreadId } from "@ace/protocol";
import { FolderWatch, type FolderWatchClient, type FoldersChanged } from "./folder-watch.ts";
import { FilesTool } from "./tool.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});

/** Advance the manual clock between real handshakes until `predicate`, since the child is real. */
async function advanceUntil(
  clock: ManualClock,
  predicate: () => boolean,
  ms = 4_000,
): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    await clock.advance(200);
    await settle();
    if (predicate()) return;
    if (Date.now() > end) throw new Error("timed out waiting for ace-files");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

it("asks a watching client to re-list after ace-files restarted mid-watch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ace-files-restart-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const clock = new ManualClock();
  const host = trackingHost(
    nodeFilesHost({ ...process.env }, () => ({
      command: process.execPath,
      args: [fakeFilesScript()],
    })),
  );
  const tool = new FilesTool({ binary: "/fake/ace-files", host, clock });
  cleanup.push(() => void tool.close());
  const folders = new FolderWatch(
    { watch: (path, onBatch) => tool.watch(path, onBatch) },
    { clock },
  );
  cleanup.push(() => void folders.close());

  const threadId = ThreadId.parse("restart");
  const inbox: FoldersChanged[] = [];
  const client: FolderWatchClient = {
    id: "phone",
    sendable: () => true,
    valid: () => true,
    send: (message) => inbox.push(message),
  };
  await folders.watch(client, threadId, dir, [""]);
  // The fake reports one change as soon as its watch starts; let that push window close.
  await advanceUntil(clock, () => inbox.length > 0);
  inbox.length = 0;

  host.children.at(-1)?.kill();
  // The supervisor restarts with its 250 ms backoff; the clock also closes the push window.
  await advanceUntil(clock, () => inbox.some((message) => message.rescan));
  expect(inbox).toContainEqual({
    type: "files.folders_changed",
    threadId,
    folders: [""],
    rescan: true,
  });
  expect(host.children.length).toBe(2);
}, 8_000);
