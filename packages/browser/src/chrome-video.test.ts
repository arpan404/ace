import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";
import { ChromeVideo } from "./chrome-video.ts";
import { CdpConnection } from "./cdp-connection.ts";
import { videoExtensionId } from "./video-extension.ts";

const workerUrl = `chrome-extension://${videoExtensionId}/worker.js`;
const offscreenUrl = `chrome-extension://${videoExtensionId}/offscreen.html`;

type Globals = Record<string, unknown>;

function driver(options: { workerGlobals: Globals; offscreenGlobals: Globals }) {
  const workerTargetId = "worker-target";
  const offscreenTargetId = "offscreen-target";
  const workerSessionId = "worker-session";
  const offscreenSessionId = "offscreen-session";
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
              { targetId: offscreenTargetId, type: "page", url: offscreenUrl },
            ],
          };
        if (method === "Target.attachToTarget") {
          if (params?.["targetId"] === workerTargetId) return { sessionId: workerSessionId };
          if (params?.["targetId"] === offscreenTargetId) return { sessionId: offscreenSessionId };
          throw new Error("Unknown target");
        }
        if (method === "Runtime.runIfWaitingForDebugger") return {};
        if (method === "Runtime.addBinding") return {};
        if (method === "Runtime.evaluate") {
          const globals =
            sessionId === workerSessionId
              ? options.workerGlobals
              : sessionId === offscreenSessionId
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

test("on Windows, supported waits for the extension scripts before calling their exports", async () => {
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
      platform: "win32",
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
});

test("on Windows, supported rejects bounded when the extension scripts never define their exports", async () => {
  const dir = await directory();
  try {
    const delays: number[] = [];
    const connection = driver({ workerGlobals: {}, offscreenGlobals: {} });
    const video = new ChromeVideo({
      connection,
      targets: { keep: () => {} },
      directory: dir.path,
      platform: "win32",
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
