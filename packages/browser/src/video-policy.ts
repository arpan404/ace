import type { BrowserCaptureViewport } from "@ace/protocol";
import { longestFrameSide } from "./capture-policy.ts";

/*
 * Which video encodes a tab runs for its viewers, and who watches which (ADR 0088). Pure: the
 * live capture feeds it the page, what the encoder can do and each viewer's pane and load.
 *
 * A viewer gets the pixels its screen shows the page at, always at 60 frames per second.
 * Viewers share an encode when their codec matches and the shared picture is at most a quarter
 * larger than their own. What a link can't carry costs picture quality, never frames: each
 * encode's bit rate is the lowest its viewers' links carry (`link-rate.ts`), and changes in
 * place without a new encoder.
 */

export interface VideoViewer {
  id: string;
  viewport: BrowserCaptureViewport;
  /** The codecs the viewer's decoder supports, best first. */
  codecs: readonly string[];
  /** Bits per second the viewer's link carries now. */
  link: number;
  /** The share of its full picture (per side) the link carries at 60 fps (`video-scale.ts`). */
  scale?: number;
}

export interface VideoSource {
  /** The page's CSS size. */
  width: number;
  height: number;
  /** Pixels the tab renders per CSS pixel: no encode is sharper than the tab itself. */
  scale: number;
  /** The codecs the encoder supports. */
  codecs: readonly string[];
}

export interface VideoEncode {
  /**
   * Stable while the encoder's codec and size are: a new key is a new encoder (and a keyframe).
   * The bit rate is not part of it; the encoder takes a new one in place.
   */
  key: string;
  codec: string;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
}

export interface VideoPlan {
  encodes: VideoEncode[];
  /** The tab capture's size: the largest full picture. Encoders scale it down themselves. */
  capture: { width: number; height: number };
  /** Each video viewer's encode key. A viewer missing here takes JPEG frames. */
  viewers: Map<string, string>;
}

/** Encoders one tab runs at most; more viewers join the nearest one. */
export const maxEncodes = 4;
/** A shared picture may be this much larger (per side) than a member's own. */
const shareSlack = 1.25;
/** Every live view runs at this rate (owner decision, ADR 0088 amendment). */
export const videoFps = 60;
/** Bits per pixel per frame a picture gets at most: sharp text, more is wasted. */
const ceilingBpp = 0.06;
export const minBitrate = 500_000;
export const maxBitrate = 16_000_000;

const even = (value: number) => Math.max(2, 2 * Math.round(value / 2));

/** The picture one viewer needs: the page at the size its pane shows it, in device pixels. */
export function viewerPicture(
  source: Pick<VideoSource, "width" | "height" | "scale">,
  viewport: BrowserCaptureViewport,
): { width: number; height: number } {
  const shown = Math.min(viewport.width / source.width, viewport.height / source.height);
  const scale = Math.min(
    shown * viewport.devicePixelRatio,
    source.scale,
    longestFrameSide / Math.max(source.width, source.height),
  );
  return { width: even(source.width * scale), height: even(source.height * scale) };
}

/** The most bits per second a picture of this size is worth at 60 fps. */
export function bitrateCeiling(picture: { width: number; height: number }): number {
  return Math.round(
    Math.min(
      maxBitrate,
      Math.max(minBitrate, picture.width * picture.height * videoFps * ceilingBpp),
    ),
  );
}

export function encodeSettings(
  codec: string,
  picture: { width: number; height: number },
  link: number,
): VideoEncode {
  const fps = videoFps;
  const bitrate = Math.round(Math.max(minBitrate, Math.min(bitrateCeiling(picture), link)));
  return {
    key: `${codec}/${picture.width}x${picture.height}/${fps}`,
    codec,
    width: picture.width,
    height: picture.height,
    fps,
    bitrate,
  };
}

interface Group {
  codec: string;
  link: number;
  width: number;
  height: number;
  members: string[];
}

export function planVideo(source: VideoSource, viewers: readonly VideoViewer[]): VideoPlan {
  const wanted = viewers.flatMap((viewer) => {
    const codec = viewer.codecs.find((candidate) => source.codecs.includes(candidate));
    if (!codec || viewer.viewport.nativeShown) return [];
    const full = viewerPicture(source, viewer.viewport);
    const scale = viewer.scale ?? 1;
    return [
      {
        id: viewer.id,
        codec,
        link: viewer.link,
        full,
        width: even(full.width * scale),
        height: even(full.height * scale),
      },
    ];
  });
  // Largest first, so a group's first member sets its size and later ones are no larger.
  wanted.sort((a, b) => b.width * b.height - a.width * a.height || a.id.localeCompare(b.id));
  const groups: Group[] = [];
  for (const viewer of wanted) {
    const fits = groups.find(
      (group) =>
        group.codec === viewer.codec &&
        group.width <= viewer.width * shareSlack &&
        group.height <= viewer.height * shareSlack,
    );
    if (fits) {
      fits.members.push(viewer.id);
      fits.link = Math.min(fits.link, viewer.link);
      continue;
    }
    if (groups.length < maxEncodes) {
      groups.push({
        codec: viewer.codec,
        link: viewer.link,
        width: viewer.width,
        height: viewer.height,
        members: [viewer.id],
      });
      continue;
    }
    // Out of encoders: the nearest encode of the same codec.
    const nearest = groups
      .filter((group) => group.codec === viewer.codec)
      .toSorted(
        (a, b) =>
          Math.abs(a.width * a.height - viewer.width * viewer.height) -
          Math.abs(b.width * b.height - viewer.width * viewer.height),
      )[0];
    if (nearest) {
      nearest.members.push(viewer.id);
      nearest.link = Math.min(nearest.link, viewer.link);
    }
  }
  const capture = { width: 0, height: 0 };
  for (const viewer of wanted) {
    capture.width = Math.max(capture.width, viewer.full.width);
    capture.height = Math.max(capture.height, viewer.full.height);
  }
  const plan: VideoPlan = { encodes: [], capture, viewers: new Map() };
  for (const group of groups) {
    const encode = encodeSettings(group.codec, group, group.link);
    plan.encodes.push(encode);
    for (const member of group.members) plan.viewers.set(member, encode.key);
  }
  return plan;
}
