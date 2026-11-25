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

/** The worker exports the daemon calls, as a build Chrome can use defines them. */
const modernWorker = () => ({
  ready: async () => {},
  open: async () => ({ streamId: "stream-1" }),
  tabFor: async (targetId: string) => Number(targetId.replace("target-", "")),
  tabAudio: async () => ({ audible: false, muted: false }),
  mute: async () => {},
});

/** The offscreen document exports the daemon calls. */
const modernDocument = () => ({
  supported: async (codecs: readonly string[]) => codecs,
  start: async () => {},
  encodes: () => {},
  keyframe: () => {},
  audio: () => {},
  ingest: () => {},
  epoch: () => {},
  stop: () => {},
});

function driver(options: {
  workerGlobals: Globals;
  offscreenGlobals: Globals;
  /** The extension's targets now; they change when it is installed again. */
  targets?: () => { worker: string; offscreen: string };
  uninstall?: () => void;
  /**
   * The extension's targets start paused, as Chrome starts a target it auto-attaches: an
   * evaluate on one never answers until `Runtime.runIfWaitingForDebugger` lets it run.
   */
  paused?: boolean;
}) {
  const resumed = new Set<string>();
  const targets = options.targets ?? (() => ({ worker: "worker", offscreen: "offscreen" }));
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
        if (method === "Extensions.uninstall") {
          options.uninstall?.();
          return {};
        }
        if (method === "Target.getTargets")
          return {
            targetInfos: [
              { targetId: targets().worker, type: "service_worker", url: workerUrl },
              { targetId: targets().offscreen, type: "page", url: offscreenUrl },
            ],
          };
        if (method === "Target.attachToTarget") {
          if (params?.["targetId"] === targets().worker)
            return { sessionId: `${targets().worker}-worker` };
          if (params?.["targetId"] === targets().offscreen)
            return { sessionId: `${targets().offscreen}-document` };
          throw new Error("Unknown target");
        }
        if (method === "Runtime.runIfWaitingForDebugger") {
          if (sessionId) resumed.add(sessionId);
          return {};
        }
        if (method === "Runtime.addBinding") return {};
        if (method === "Runtime.evaluate") {
          const globals = sessionId?.endsWith("-worker")
            ? options.workerGlobals
            : sessionId?.endsWith("-document")
              ? options.offscreenGlobals
              : undefined;
          if (!globals) return {};
          if (options.paused && sessionId && !resumed.has(sessionId))
            return new Promise<never>(() => {});
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

test("the encoder waits for the extension's paused scripts to run before calling their exports", async () => {
  const dir = await directory();
  try {
    const workerGlobals: Globals = {};
    const offscreenGlobals: Globals = {};
    let delays = 0;
    // Under load Chrome attaches the worker and document before their scripts ran, on any
    // platform: an export called then throws, or never answers while the target is paused.
    const connection = driver({ workerGlobals, offscreenGlobals, paused: true });
    const video = new ChromeVideo({
      connection,
      targets: { keep: () => {} },
      directory: dir.path,
      delay: async () => {
        delays++;
        if (delays === 2) workerGlobals.aceVideo = modernWorker();
        if (delays === 4)
          offscreenGlobals.aceVideo = {
            ...modernDocument(),
            supported: async (codecs: readonly string[]) =>
              codecs.filter((codec) => codec === "vp8"),
          };
      },
    });
    await expect(video.supported(["vp8"], 320, 200)).resolves.toEqual(["vp8"]);
  } finally {
    await dir.cleanup();
  }
});

test("the encoder fails in bounded time when the extension's scripts never define their exports", async () => {
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
});

/**
 * Chrome's tab capture as the video extension meets it, one tab per Chrome tab: a stream id works
 * once; tab 1's capture with sound fails `failWithSound` times, and the first `leaks` of those leave
 * their tab held until the extension is uninstalled; a stop takes `stopMs` to release its tab.
 */
function chromeCapture(options: { failWithSound?: number; leaks?: number; stopMs?: number } = {}) {
  let ids = 0;
  let loads = 1;
  const minted = new Map<string, number>();
  const used = new Set<string>();
  /** Tab of each running capture, and tabs a failed capture left held. */
  const live = new Map<string, number>();
  const held = new Set<number>();
  let failWithSound = options.failWithSound ?? 0;
  let leaks = options.leaks ?? 0;
  const workerGlobals: Globals = {
    aceVideo: {
      ...modernWorker(),
      /** The daemon knows a page by its CDP target; this Chrome has one tab per target. */
      tabFor: async (targetId: string) => Number(targetId.replace("target-", "")),
      open: async (tabId: number) => {
        if (held.has(tabId) || [...live.values()].includes(tabId))
          throw new Error("Cannot capture a tab with an active stream.");
        const streamId = `stream-${++ids}`;
        minted.set(streamId, tabId);
        return { streamId };
      },
    },
  };
  const offscreenGlobals: Globals = {
    aceVideo: {
      ...modernDocument(),
      supported: async (codecs: readonly string[]) => codecs,
      start: async (id: string, streamId: string, _w: number, _h: number, opts?: object) => {
        const tabId = minted.get(streamId);
        if (tabId === undefined || used.has(streamId))
          throw new Error("AbortError: Error starting tab capture");
        used.add(streamId);
        if (tabId === 1 && !(opts && "audio" in opts) && failWithSound > 0) {
          failWithSound--;
          if (leaks > 0) {
            leaks--;
            held.add(tabId);
          }
          throw new Error("AbortError: Failed due to shutdown");
        }
        live.set(id, tabId);
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
  return {
    workerGlobals,
    offscreenGlobals,
    uninstall: () => {
      held.clear();
      live.clear();
      loads++;
    },
    targets: () => ({ worker: `worker-${loads}`, offscreen: `offscreen-${loads}` }),
  };
}

/** The page on CDP target `target-${tabId}`, which the worker maps back to Chrome tab `tabId`. */
const page = (tabId: number) => ({
  send: async (method: string) =>
    method === "Target.getTargetInfo" ? { targetInfo: { targetId: `target-${tabId}` } } : {},
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

test("a failed capture that left its tab held is freed by installing the encoder again, and opens", async () => {
  const v = await encoder(chromeCapture({ failWithSound: 2, leaks: 1 }));
  // Another tab is watched too: installing the encoder again ends its capture, so its viewers reopen it.
  const other = viewer();
  await v.open(page(2), 800, 600, other.events);
  await expect(v.open(page(1), 800, 600, viewer().events)).resolves.toBeDefined();
  expect(other.seen.ended).toBe(1);
  // The new encoder captures as before.
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

test("a running worker from an older build is installed again, and the capture opens", async () => {
  const dir = await directory();
  onTestFinished(dir.cleanup);
  const workerGlobals: Globals = {
    aceVideo: { ready: async () => {}, open: async () => ({ streamId: "old" }) },
  };
  const documentGlobals: Globals = { aceVideo: { supported: async () => [] } };
  let installs = 0;
  const connection = driver({
    workerGlobals,
    offscreenGlobals: documentGlobals,
    targets: () => ({ worker: `worker-${installs}`, offscreen: `offscreen-${installs}` }),
    uninstall: () => {
      installs++;
      workerGlobals.aceVideo = modernWorker();
      documentGlobals.aceVideo = modernDocument();
    },
  });
  const video = new ChromeVideo({
    connection,
    targets: { keep: () => {} },
    directory: dir.path,
    delay: async () => {},
  });
  const handle = await video.open(page(1), 800, 600, viewer().events);
  expect(handle).toBeDefined();
  expect(installs).toBe(1);
});

test("a build still out of date after installing again fails naming the missing exports", async () => {
  const dir = await directory();
  onTestFinished(dir.cleanup);
  const workerGlobals: Globals = {
    aceVideo: { ready: async () => {}, open: async () => ({ streamId: "old" }) },
  };
  const documentGlobals: Globals = { aceVideo: { supported: async () => [] } };
  let installs = 0;
  const connection = driver({
    workerGlobals,
    offscreenGlobals: documentGlobals,
    targets: () => ({ worker: `worker-${installs}`, offscreen: `offscreen-${installs}` }),
    uninstall: () => {
      installs++;
    },
  });
  const video = new ChromeVideo({
    connection,
    targets: { keep: () => {} },
    directory: dir.path,
    delay: async () => {},
  });
  await expect(video.open(page(1), 800, 600, viewer().events)).rejects.toThrow(
    "The video extension is out of date: aceVideo.tabFor",
  );
  expect(installs).toBe(1);
});
