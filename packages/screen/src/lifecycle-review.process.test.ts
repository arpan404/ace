import { expect, it } from "vitest";
import { windowsFixture } from "./testing/windows-fixture.ts";
import { deferred } from "./testing/support.ts";
import { spawnWindowsHelper } from "./windows-process.ts";
import type { Frame, RecordingArtifact } from "./index.ts";

it("a backpressured old packet cannot fail a replacement session", async () => {
  const f = await windowsFixture({ env: { BACKPRESSURE_RESTART: "1" } });
  try {
    const first = await f.start();
    await f.manager.stop(first.sessionId);
    const next = await f.start();
    const frame = await f.manager.screenshotFresh(next.sessionId);
    expect(frame.header.sessionId).toBe(next.sessionId);
    expect(f.manager.state(next.sessionId).lifecycle).toBe("live");
  } finally {
    await f.close();
  }
});
it("a paused packet cannot satisfy a post-resume snapshot", async () => {
  const f = await windowsFixture({ env: { RETIRED_ON_RESUME: "1" } });
  try {
    const session = await f.start();
    const first = await f.manager.screenshotFresh(session.sessionId);
    await f.manager.targets();
    const fresh = await f.manager.screenshotFresh(session.sessionId);
    expect(fresh.payload.toString()).toBe("fresh");
    expect(fresh.header.sequence).toBeGreaterThan(first.header.sequence);
    expect(f.manager.state(session.sessionId).lifecycle).toBe("live");
  } finally {
    await f.close();
  }
});
it("native capture stops before a deferred recording publisher can turn off the indicator", async () => {
  const publishing = deferred<void>();
  const release = deferred<void>();
  const f = await windowsFixture({
    publishArtifact: async () => {
      publishing.resolve();
      await release.promise;
    },
  });
  try {
    const session = await f.start();
    const frame = deferred<Frame>();
    const unsubscribe = f.manager.subscribe(session.sessionId, async (value) =>
      frame.resolve(value),
    );
    await frame.promise;
    await f.manager.startRecording(session.sessionId);
    const stopping = f.manager.stop(session.sessionId);
    expect(f.manager.state(session.sessionId)).toMatchObject({
      lifecycle: "stopping",
      indicator: true,
    });
    await publishing.promise;
    expect((await f.manager.targets()).windows[0]?.title).toMatch(/:false$/);
    expect(f.manager.state(session.sessionId)).toMatchObject({
      lifecycle: "stopped",
      indicator: false,
    });
    unsubscribe();
    release.resolve();
    await stopping;
  } finally {
    release.resolve();
    await f.close();
  }
});
it("publication rejection cannot leak the host helper during shutdown", async () => {
  const exited = deferred<unknown>();
  const f = await windowsFixture({
    publishArtifact: async () => {
      throw new Error("publish rejected");
    },
    spawn: (options) => {
      const child = spawnWindowsHelper(options);
      void child.exited.then(exited.resolve);
      return child;
    },
  });
  try {
    const session = await f.start();
    await f.manager.startRecording(session.sessionId);
    await expect(f.manager.close()).rejects.toThrow();
    await exited.promise;
    expect(f.manager.states()).toEqual([]);
  } finally {
    await f.close();
  }
});
it("recording completion at its cap releases capture demand and permits another recording", async () => {
  const published = deferred<RecordingArtifact>();
  const f = await windowsFixture({
    recordingLimitBytes: 1,
    publishArtifact: async (artifact) => {
      published.resolve(artifact);
    },
  });
  try {
    const session = await f.start();
    await f.manager.screenshotFresh(session.sessionId);
    await f.manager.startRecording(session.sessionId);
    expect((await published.promise).bytes).toBe(0);
    expect((await f.manager.targets()).windows[0]?.title).toMatch(/:false$/);
    await f.manager.startRecording(session.sessionId);
    await f.manager.stopRecording(session.sessionId);
  } finally {
    await f.close();
  }
});
it("native stop and publication failures both remain observable after actual helper exit", async () => {
  const exited = deferred<unknown>();
  const f = await windowsFixture({
    env: { STOP_ERROR: "1" },
    publishArtifact: async () => {
      throw new Error("publish rejected");
    },
    spawn: (options) => {
      const child = spawnWindowsHelper(options);
      void child.exited.then(exited.resolve);
      return child;
    },
  });
  try {
    const session = await f.start();
    await f.manager.startRecording(session.sessionId);
    await expect(f.manager.stop(session.sessionId)).rejects.toMatchObject({
      errors: expect.arrayContaining([
        expect.objectContaining({ message: "native stop rejected" }),
        expect.objectContaining({ message: "publish rejected" }),
      ]),
    });
    await exited.promise;
    expect(f.manager.states()).toEqual([]);
  } finally {
    await f.close();
  }
});
it("a failed frame subscriber releases the last capture viewer", async () => {
  const failed = deferred<void>();
  const f = await windowsFixture();
  try {
    const session = await f.start();
    const unsubscribe = f.manager.subscribe(session.sessionId, async () => {
      failed.resolve();
      throw new Error("peer closed");
    });
    await failed.promise;
    // Snapshot also provides a command/frame barrier after the rejected send callback.
    await f.manager.screenshotFresh(session.sessionId);
    await f.manager.targets();
    expect((await f.manager.targets()).windows[0]?.title).toMatch(/:false$/);
    unsubscribe();
  } finally {
    await f.close();
  }
});
