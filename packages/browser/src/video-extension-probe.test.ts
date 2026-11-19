import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";
import { videoExtensionFiles } from "./video-extension.gen.ts";
import { refreshPictureMs } from "./video-pacing.ts";

/*
 * The video extension's offscreen document (the bundle the daemon installs) against a fake
 * Chrome tab capture: a tab whose capture, or any clone of its track, is still live refuses a
 * new capture, as Chrome does. That refusal is what sends the daemon to install the extension
 * again, which ends every other capture too.
 */

interface Track {
  stopped: boolean;
  clone(): Track;
  stop(): void;
}

/** `refuseExtraSinks`: a sink on anything but the capture's own track throws, as Chrome may. */
function offscreen(options: { refuseExtraSinks?: boolean } = {}) {
  let clock = 0;
  const timers: { id: number; at: number; every?: number; run: () => void }[] = [];
  let ids = 0;
  const schedule = (run: () => void, milliseconds: number, every?: number) => {
    const id = ++ids;
    timers.push({ id, at: clock + milliseconds, ...(every ? { every } : {}), run });
    return id;
  };
  const cancel = (id: unknown) => {
    const index = timers.findIndex((timer) => timer.id === id);
    if (index !== -1) timers.splice(index, 1);
  };
  /** Every track of the one tab, clones included. */
  const tracks: Track[] = [];
  const track = (): Track => {
    const made: Track = {
      stopped: false,
      clone: () => track(),
      stop: () => {
        made.stopped = true;
      },
    };
    tracks.push(made);
    return made;
  };
  class MediaStream {
    private video: Track;
    constructor(video: Track) {
      this.video = video;
    }
    getVideoTracks() {
      return [this.video];
    }
    getAudioTracks() {
      return [];
    }
  }
  /** A still page: its sinks never get a picture. */
  class MediaStreamTrackProcessor {
    constructor(init: { track: Track }) {
      if (options.refuseExtraSinks && init.track !== tracks[0])
        throw new Error("InvalidStateError");
    }
    readable = {
      getReader: () => {
        let finish: ((result: { done: boolean }) => void) | undefined;
        return {
          read: () =>
            new Promise<{ done: boolean }>((resolve) => {
              finish = resolve;
            }),
          cancel: async () => finish?.({ done: true }),
        };
      },
    };
  }
  const globals: Record<string, unknown> = {
    performance: { now: () => clock },
    setInterval: (run: () => void, milliseconds: number) =>
      schedule(run, milliseconds, milliseconds),
    setTimeout: (run: () => void, milliseconds: number) => schedule(run, milliseconds),
    clearTimeout: cancel,
    clearInterval: cancel,
    MediaStream,
    MediaStreamTrackProcessor,
    navigator: {
      mediaDevices: {
        getUserMedia: async () => {
          if (tracks.some((held) => !held.stopped))
            throw new Error("Cannot capture a tab with an active stream.");
          return new MediaStream(track());
        },
      },
    },
    aceVideoEmit: () => {},
  };
  const bundle = videoExtensionFiles["offscreen.js"];
  if (!bundle) throw new Error("The offscreen bundle is missing");
  runInNewContext(bundle, globals);
  const api = globals["aceVideo"] as {
    start(
      id: string,
      streamId: string,
      width: number,
      height: number,
      options: object,
    ): Promise<void>;
    stop(id: string): void;
  };
  return {
    api,
    tracks,
    /** Lets `milliseconds` pass on the document's clock, running its timers as they come due. */
    async advance(milliseconds: number) {
      const until = clock + milliseconds;
      for (;;) {
        const next = timers.filter((timer) => timer.at <= until).toSorted((a, b) => a.at - b.at)[0];
        if (!next) break;
        clock = next.at;
        if (next.every) next.at += next.every;
        else cancel(next.id);
        next.run();
        await Promise.resolve();
      }
      clock = until;
    },
  };
}

test("a capture stopped while it is asking for its first picture lets go of the tab at once", async () => {
  const page = offscreen();
  await page.api.start("capture-1", "stream-1", 800, 600, { audio: false });
  // No picture comes: the capture asks for one with an extra sink on a clone of its track.
  await page.advance(refreshPictureMs + 50);
  const clone = page.tracks[1];
  expect(clone?.stopped).toBe(false);
  // A resize stops the capture while that sink waits for a picture.
  page.api.stop("capture-1");
  expect(page.tracks.every((held) => held.stopped)).toBe(true);
  // The replacement capture of the same tab is taken, not refused (which would reinstall the
  // extension and end every other capture).
  await expect(page.api.start("capture-2", "stream-2", 1024, 768, { audio: false })).resolves.toBe(
    undefined,
  );
});

test("an extra sink Chrome refuses to make still lets go of its clone", async () => {
  const page = offscreen({ refuseExtraSinks: true });
  await page.api.start("capture-1", "stream-1", 800, 600, { audio: false });
  await page.advance(refreshPictureMs + 50);
  expect(page.tracks.length).toBe(2);
  expect(page.tracks[1]?.stopped).toBe(true);
});
