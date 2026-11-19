import { afterEach, expect, test } from "vitest";
import type { ThreadId } from "@ace/protocol";
import type { Store } from "@ace/daemon";
import {
  cleanupRecovery,
  crashCopy,
  fixture,
  replaceProvider,
  sends,
} from "./recovery-test-support.ts";
import { end, scriptFrames, start } from "./test-support.ts";

afterEach(cleanupRecovery);

function notices(store: Store, id: ThreadId) {
  return Object.values(store.snapshotThread(id).items).flatMap((item) =>
    item.type === "notice" ? [{ code: item.code, text: item.text }] : [],
  );
}

test.runIf(process.platform === "win32")(
  "Windows: after a crash whose processes could not all be verified gone, the cut-short turn is neither reported stopped nor continued",
  async () => {
    const frames = scriptFrames();
    const h = await fixture([{ on: "send", frames: [frames.frame(start)] }], frames);
    const id = await h.create();
    await h.engine.flush();
    const replacement = replaceProvider(h, frames, [
      { on: "send", frames: [frames.frame(start, end)] },
    ]);

    const recovered = await crashCopy(h, { previousProcessesUnverified: true });
    h.clock.advance(h.clock.now() + 60_000);
    await recovered.engine.flush();

    // Starting the work again could run it twice beside a survivor.
    expect(sends(replacement)).toEqual([]);
    expect(notices(recovered.store, id)).toContainEqual({
      code: "recovery_uncertain",
      text: "Some processes from the previous run may still be running",
    });
    expect(notices(recovered.store, id).map((notice) => notice.code)).not.toContain(
      "restart_interrupted",
    );
  },
);
