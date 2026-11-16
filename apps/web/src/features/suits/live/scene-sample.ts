import type { SceneHostMessage } from "@ace/protocol/suits";
import { messageFromScene } from "../scene/scene-controller.ts";
import { readVideoFrame } from "../video/video-frame.ts";
import type { SceneGrid } from "./colour-check.ts";

/*
 * Reads what each Suit scene shows now, for the live contrast check. It asks the scene's
 * sandboxed frame for a `sample` (the runtime averages its canvas to a small grid) and never
 * reaches into the frame: the sandbox stays as it is. A scene that can't answer (its canvas is
 * tainted by an image, or it is stopped) gives no grid, and the text over it is listed as
 * unchecked rather than guessed.
 */

export interface SceneFrame {
  /** The element the frame sits in: everything inside it paints over the scene. */
  host: Element;
  /** Elements over the scene and under the host's content (`data-suit-veil`). */
  veils: Element[];
  grid: SceneGrid | undefined;
}

const columns = 24;
const rows = 16;
const waitMs = 800;
let next = 1;

function sampleOne(frame: HTMLIFrameElement, view: Window): Promise<SceneGrid | undefined> {
  const target = frame.contentWindow;
  if (!target) return Promise.resolve(undefined);
  const id = next++;
  return new Promise((resolve) => {
    const done = (grid: SceneGrid | undefined) => {
      view.removeEventListener("message", onMessage);
      view.clearTimeout(timer);
      resolve(grid);
    };
    const onMessage = (event: MessageEvent) => {
      const message = messageFromScene(event, target);
      if (message?.type !== "sample" || message.id !== id) return;
      if (message.pixels.length !== message.columns * message.rows * 4) return done(undefined);
      const rect = frame.getBoundingClientRect();
      done({
        columns: message.columns,
        rows: message.rows,
        pixels: message.pixels,
        box: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      });
    };
    const timer = view.setTimeout(() => done(undefined), waitMs);
    view.addEventListener("message", onMessage);
    const ask: SceneHostMessage = { type: "sample", id, columns, rows };
    target.postMessage(ask, "*");
  });
}

/**
 * A Suit's video as it shows now (ADR 0169), read in the page itself: the video is ace's own
 * element. A frame the page can't read (no CORS) gives no grid, so the text over it is unchecked.
 */
function sampleVideo(video: HTMLVideoElement | HTMLImageElement): SceneGrid | undefined {
  const fit = video.dataset.fit === "contain" ? "contain" : "cover";
  try {
    const read = readVideoFrame(video, columns, rows, fit);
    return read ? { columns, rows, pixels: Array.from(read.pixels), box: read.box } : undefined;
  } catch {
    return undefined;
  }
}

const veilsIn = (host: Element) =>
  [...host.children].filter((child) => child.hasAttribute("data-suit-veil"));

/** Every scene frame and Suit video on the page with what it shows now. */
export async function sampleScenes(document: Document): Promise<SceneFrame[]> {
  const view = document.defaultView;
  if (!view) return [];
  const frames = [...document.querySelectorAll<HTMLIFrameElement>("iframe[data-suit-scene-frame]")];
  // A Suit's video, or the still image that stands in for one.
  const videos = [
    ...document.querySelectorAll<HTMLVideoElement | HTMLImageElement>(
      "video[data-suit-video], img[data-suit-poster]",
    ),
  ];
  const scenes = await Promise.all(
    frames.map(async (frame) => {
      const host = frame.parentElement ?? document.documentElement;
      return { host, veils: veilsIn(host), grid: await sampleOne(frame, view) };
    }),
  );
  return [
    ...scenes,
    ...videos.map((video) => {
      const host = video.parentElement ?? document.documentElement;
      return { host, veils: veilsIn(host), grid: sampleVideo(video) };
    }),
  ];
}
