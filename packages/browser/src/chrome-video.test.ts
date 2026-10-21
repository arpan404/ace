import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { BrowserCdp } from "./backend.ts";
import { ChromeVideo } from "./chrome-video.ts";
import { videoExtensionId } from "./video-extension.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const origin = `chrome-extension://${videoExtensionId}/`;

/**
 * Chrome as the encoder sees it over CDP: loading the extension lists its service worker and
 * offscreen document at once, but each one's script defines `aceVideo` only after
 * `startsAfter` evaluations in it, as a target listed before its script ran.
 */
function chrome(startsAfter: number) {
  const evaluations = new Map<string, number>();
  const target = (sessionId: string): BrowserCdp => ({
    on: () => {},
    off: () => {},
    send: async (method, params) => {
      if (method !== "Runtime.evaluate") return {};
      const seen = (evaluations.get(sessionId) ?? 0) + 1;
      evaluations.set(sessionId, seen);
      const started = seen > startsAfter;
      const expression = String(params?.expression);
      if (expression === "typeof aceVideo")
        return { result: { value: started ? "object" : "undefined" } };
      if (!started)
        return {
          exceptionDetails: {
            text: "Uncaught",
            exception: { description: "ReferenceError: aceVideo is not defined" },
          },
        };
      if (expression.startsWith("aceVideo.supported"))
        return { result: { value: ["avc1.42E033"] } };
      return { result: {} };
    },
  });
  return {
    connection: {
      send: async (method: string, params?: Record<string, unknown>) => {
        if (method === "Extensions.loadUnpacked") return { id: videoExtensionId };
        if (method === "Target.getTargets")
          return {
            targetInfos: [
              { targetId: "worker", type: "service_worker", url: `${origin}worker.js` },
              { targetId: "document", type: "other", url: `${origin}offscreen.html` },
            ],
          };
        if (method === "Target.attachToTarget") return { sessionId: String(params?.targetId) };
        return {};
      },
      session: (sessionId: string) => target(sessionId),
    },
  };
}

async function video(startsAfter: number): Promise<ChromeVideo> {
  const directory = await mkdtemp(join(tmpdir(), "ace-video-extension-"));
  directories.push(directory);
  return new ChromeVideo({
    connection: chrome(startsAfter).connection,
    targets: { keep: () => {} },
    directory,
    // Waits are real but short: a reply from the fake Chrome always comes first.
    delay: () => new Promise((resolve) => setTimeout(resolve, 1)),
  });
}

it("codec support is read once the extension's scripts run, though their targets are listed first", async () => {
  const encoder = await video(3);
  expect(await encoder.supported(["avc1.42E033"], 370, 616)).toEqual(["avc1.42E033"]);
});

it("an extension whose scripts never run fails to load instead of answering for them", async () => {
  const encoder = await video(Infinity);
  await expect(encoder.supported(["avc1.42E033"], 370, 616)).rejects.toThrow(
    "The video extension did not start",
  );
});
