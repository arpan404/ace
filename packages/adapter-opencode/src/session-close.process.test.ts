import { expect, it } from "vitest";
import type { Frame } from "@ace/engine-api";
import { ThreadId } from "@ace/protocol";
import { spawnSupervised } from "@ace/provider-kit/process";
import { OpenCodeServer } from "./server.ts";
import { OpenCodeSession } from "./session.ts";
import { object } from "./data.ts";
import { ownClose, setup } from "./testing/v2-session.ts";

/** An OpenCode server whose stop cannot confirm its tree ended, as a Windows survivor leaves it. */
const survivingServer: typeof spawnSupervised = (options) => {
  const proc = spawnSupervised(options);
  return {
    ...proc,
    stop: (stop) =>
      proc.stop(stop).then(() => {
        throw new Error("Windows process tree survived its stop");
      }),
  };
};

it("a cancelled session whose server stop fails records it once, and an awaited close still fails", async () => {
  const h = await setup({ runtime: { spawn: survivingServer } });
  ownClose(h.adapter);
  h.controller.abort(new Error("cancelled"));
  // A close that arrives while the cancelled one is still stopping waits for its outcome.
  await expect(h.session.close("user")).rejects.toThrow("survived its stop");
  await expect(h.session.close("user")).rejects.toThrow("survived its stop");
  const failures = h.frames.filter(
    (frame) => frame.channel === "lifecycle" && object(frame.data).type === "stop-failed",
  );
  expect(failures).toHaveLength(1);
  // The pool still owns the server whose stop failed; shutting the adapter down says so too.
  await expect(h.adapter.close()).rejects.toThrow("survived its stop");
});

it("a close that arrives while a cancelled session is still stopping its server waits for the outcome", async () => {
  const h = await setup();
  const server = new OpenCodeServer({
    ...h.options,
    runtime: { ...h.options.runtime, spawn: survivingServer },
  });
  const controller = new AbortController();
  const frames: Frame[] = [];
  const session = await OpenCodeSession.open(
    {
      threadId: ThreadId.parse("thread_close"),
      rootKey: "root",
      cwd: "/one",
      model: "opencode-go/muse-spark-1.3-contributor",
      signal: controller.signal,
      onFrame: (frame) => frames.push(frame),
      onExit: () => {},
    },
    server,
  );
  controller.abort(new Error("cancelled"));
  await expect(session.close("user")).rejects.toThrow("survived its stop");
  await expect
    .poll(() =>
      frames.filter((f) => f.channel === "lifecycle" && object(f.data).type === "stop-failed"),
    )
    .toHaveLength(1);
});
