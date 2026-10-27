import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, onTestFinished, test } from "vitest";
import { ChromeVideo } from "./chrome-video.ts";
import { CdpConnection } from "./cdp-connection.ts";
import { videoExtensionId } from "./video-extension.ts";

const workerUrl = `chrome-extension://${videoExtensionId}/worker.js`;
const offscreenUrl = `chrome-extension://${videoExtensionId}/offscreen.html`;

type Globals = Record<string, unknown>;

function driver(options: {
  workerGlobals: Globals;
  offscreenGlobals: Globals;
  /** The encoding document's target now; it changes when the document is reopened. */
  offscreenTarget?: () => string;
}) {
  const workerTargetId = "worker-target";
  const workerSessionId = "worker-session";
  const offscreenTarget = options.offscreenTarget ?? (() => "offscreen-target");
  const connection = new CdpConnection({
    write: () => {},
    schedule: (work, milliseconds) => {
      const timer = setTimeout(work, milliseconds);
      return () => clearTimeout(timer);
    },
    hung: () => {},
    intercept: {
      send: () => async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
        if (method === "Extensions.loadUnpacked") return { id: videoExtensionId };
        if (method === "Target.getTargets")
          return {
            targetInfos: [
              { targetId: workerTargetId, type: "service_worker", url: workerUrl },
              { targetId: offscreenTarget(), type: "page", url: offscreenUrl },
            ],
          };
        if (method === "Target.attachToTarget") {
          if (params?.["targetId"] === workerTargetId) return { sessionId: workerSessionId };
          if (params?.["targetId"] === offscreenTarget())
            return { sessionId: `${offscreenTarget()}-session` };
          throw new Error("Unknown target");
        }
        if (method === "Runtime.runIfWaitingForDebugger") return {};
        if (method === "Runtime.addBinding") return {};
        if (method === "Runtime.evaluate") {
          const globals =
            sessionId === workerSessionId
              ? options.workerGlobals
              : sessionId?.endsWith("-session")
                ? options.offscreenGlobals
                : undefined;
          if (!globals) return {};
          const expression = String(params?.["expression"]);
          try {
            let value: unknown = runInNewContext(expression, globals);
            if (value instanceof Promise) value = await value;
            return { result: { value } };
          } catch (error) {
            return {
              exceptionDetails: {
                text: "Uncaught",
                exception: { description: String(error) },
              },
            };
          }
        }
        return {};
      },
    },
  });
  return connection;
}

async function directory(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), "ace-chrome-video-"));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

test.runIf(process.platform === "win32")(
  "on Windows, supported waits for the extension scripts before calling their exports",
  async () => {
    const dir = await directory();
    try {
      const workerGlobals: Globals = {};
      const offscreenGlobals: Globals = {};
      let delays = 0;
      const connection = driver({ workerGlobals, offscreenGlobals });
      const video = new ChromeVideo({
        connection,
        targets: { keep: () => {} },
        directory: dir.path,
        delay: async () => {
          delays++;
          if (delays === 2)
            workerGlobals.aceVideo = {
              ready: async () => {},
              open: async () => ({ streamId: "stream-1" }),
            };
          if (delays === 4)
            offscreenGlobals.aceVideo = {
              supported: async (codecs: readonly string[]) =>
                codecs.filter((codec) => codec === "vp8"),
            };
        },
      });
      await expect(video.supported(["vp8"], 320, 200)).resolves.toEqual(["vp8"]);
    } finally {
      await dir.cleanup();
    }
  },
);

test.runIf(process.platform === "win32")(
  "on Windows, supported rejects bounded when the extension scripts never define their exports",
  async () => {
    const dir = await directory();
    try {
      const delays: number[] = [];
      const connection = driver({ workerGlobals: {}, offscreenGlobals: {} });
      const video = new ChromeVideo({
        connection,
        targets: { keep: () => {} },
        directory: dir.path,
        delay: async (milliseconds: number) => {
          delays.push(milliseconds);
        },
      });
      await expect(video.supported(["vp8"], 320, 200)).rejects.toThrow(
        "The video extension did not start",
      );
      expect(delays.length).toBeLessThanOrEqual(50);
      expect(delays.every((milliseconds) => milliseconds === 100)).toBe(true);
    } finally {
      await dir.cleanup();
    }
  },
);

/**
 * Chrome's tab capture as the video extension meets it, one tab per window: a stream id works
 * once; window 1's capture with sound fails `failWithSound` times, and the first `leaks` of those leave
 * their tab held until the document closes; a stop takes `stopMs` to release its tab.
 */
function chromeCapture(options: { failWithSound?: number; leaks?: number; stopMs?: number } = {}) {
  let ids = 0;
  let document = 1;
  const minted = new Map<string, number>();
  const used = new Set<string>();
  /** Window of each running capture, and windows a failed capture left held. */
  const live = new Map<string, number>();
  const held = new Set<number>();
  let failWithSound = options.failWithSound ?? 0;
  let leaks = options.leaks ?? 0;
  const workerGlobals: Globals = {
    aceVideo: {
      ready: async () => {},
      open: async (windowId: number) => {
        if (held.has(windowId) || [...live.values()].includes(windowId))
          throw new Error("Cannot capture a tab with an active stream.");
        const streamId = `stream-${++ids}`;
        minted.set(streamId, windowId);
        return { streamId };
      },
      reset: async () => {
        held.clear();
        live.clear();
        document++;
      },
    },
  };
  const offscreenGlobals: Globals = {
    aceVideo: {
      supported: async (codecs: readonly string[]) => codecs,
      start: async (id: string, streamId: string, _w: number, _h: number, opts?: object) => {
        const windowId = minted.get(streamId);
        if (windowId === undefined || used.has(streamId))
          throw new Error("AbortError: Error starting tab capture");
        used.add(streamId);
        if (windowId === 1 && !(opts && "audio" in opts) && failWithSound > 0) {
          failWithSound--;
          if (leaks > 0) {
            leaks--;
            held.add(windowId);
          }
          throw new Error("AbortError: Failed due to shutdown");
        }
        live.set(id, windowId);
      },
      stop: async (id: string) => {
        await new Promise((resolve) => setTimeout(resolve, options.stopMs ?? 0));
        live.delete(id);
      },
      encodes: () => {},
      keyframe: () => {},
      audio: () => {},
    },
  };
  return { workerGlobals, offscreenGlobals, offscreenTarget: () => `offscreen-${document}` };
}

/** The page shown in window `windowId`. */
const page = (windowId: number) => ({
  send: async () => ({ windowId }),
  on: () => {},
  off: () => {},
});
function viewer() {
  const seen = { ended: 0 };
  return {
    seen,
    events: { chunk: () => {}, audio: () => {}, failed: () => {}, ended: () => void seen.ended++ },
  };
}
async function encoder(chrome: ReturnType<typeof chromeCapture>) {
  const dir = await directory();
  onTestFinished(dir.cleanup);
  return new ChromeVideo({
    connection: driver(chrome),
    targets: { keep: () => {} },
    directory: dir.path,
    delay: async () => {},
  });
}

test("a capture that can't take the tab's sound streams its picture on a fresh stream id", async () => {
  const v = await encoder(chromeCapture({ failWithSound: 1 }));
  await expect(v.open(page(1), 800, 600, viewer().events)).resolves.toBeDefined();
});

test("a failed capture that left its tab held is freed by reopening the encoder, and opens", async () => {
  const v = await encoder(chromeCapture({ failWithSound: 2, leaks: 1 }));
  // Another tab is watched too: reopening the encoder ends its capture, so its viewers reopen it.
  const other = viewer();
  await v.open(page(2), 800, 600, other.events);
  await expect(v.open(page(1), 800, 600, viewer().events)).resolves.toBeDefined();
  expect(other.seen.ended).toBe(1);
  // The reopened encoder captures as before.
  await expect(v.open(page(3), 800, 600, viewer().events)).resolves.toBeDefined();
});

test("a capture asked for while the tab's last one is still stopping waits for it", async () => {
  const v = await encoder(chromeCapture({ stopMs: 50 }));
  const other = viewer();
  await v.open(page(2), 800, 600, other.events);
  const first = await v.open(page(1), 800, 600, viewer().events);
  first.close();
  await expect(v.open(page(1), 1024, 768, viewer().events)).resolves.toBeDefined();
  // Nothing else was torn down to get there.
  expect(other.seen.ended).toBe(0);
});
