import type { BrowserCaptureViewport } from "@ace/protocol";
import { longestFrameSide, type CaptureLoad } from "./capture-policy.ts";

/*
 * Which video encodes a tab runs for its viewers, and who watches which (ADR 0088). Pure: the
 * live capture feeds it the page, what the encoder can do and each viewer's pane and load.
 *
 * A viewer gets the pixels its screen shows the page at. Viewers share an encode when their
 * codec and load tier match and the shared picture is at most a quarter larger than their own;
 * a viewer that falls behind moves to a slower tier, which is its own encode, so it never slows
 * the others. Resolution stays; frame rate drops first.
 */

export interface VideoViewer {
  id: string;
  viewport: BrowserCaptureViewport;
  /** The codecs the viewer's decoder supports, best first. */
  codecs: readonly string[];
  load: CaptureLoad;
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
  /** Stable while the encode's settings are: a new key is a new encoder (and a keyframe). */
  key: string;
  codec: string;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
}

export interface VideoPlan {
  encodes: VideoEncode[];
  /** Each video viewer's encode key. A viewer missing here takes JPEG frames. */
  viewers: Map<string, string>;
}

/** Encoders one tab runs at most; more viewers join the nearest one. */
export const maxEncodes = 4;
/** A shared picture may be this much larger (per side) than a member's own. */
const shareSlack = 1.25;
const tierFps: Record<CaptureLoad, number> = { 0: 30, 1: 15, 2: 8 };
/** Bits per pixel per frame: slower tiers spend a little more on each frame they send. */
const tierBpp: Record<CaptureLoad, number> = { 0: 0.07, 1: 0.09, 2: 0.09 };
const minBitrate = 300_000;
const maxBitrate = 8_000_000;

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

export function encodeSettings(
  codec: string,
  picture: { width: number; height: number },
  tier: CaptureLoad,
): VideoEncode {
  const fps = tierFps[tier];
  const bitrate = Math.round(
    Math.min(
      maxBitrate,
      Math.max(minBitrate, picture.width * picture.height * fps * tierBpp[tier]),
    ),
  );
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
  tier: CaptureLoad;
  width: number;
  height: number;
  members: string[];
}

export function planVideo(source: VideoSource, viewers: readonly VideoViewer[]): VideoPlan {
  const wanted = viewers.flatMap((viewer) => {
    const codec = viewer.codecs.find((candidate) => source.codecs.includes(candidate));
    if (!codec || viewer.viewport.nativeShown) return [];
    return [{ id: viewer.id, codec, tier: viewer.load, ...viewerPicture(source, viewer.viewport) }];
  });
  // Largest first, so a group's first member sets its size and later ones are no larger.
  wanted.sort((a, b) => b.width * b.height - a.width * a.height || a.id.localeCompare(b.id));
  const groups: Group[] = [];
  for (const viewer of wanted) {
    const fits = groups.find(
      (group) =>
        group.codec === viewer.codec &&
        group.tier === viewer.tier &&
        group.width <= viewer.width * shareSlack &&
        group.height <= viewer.height * shareSlack,
    );
    if (fits) {
      fits.members.push(viewer.id);
      continue;
    }
    if (groups.length < maxEncodes) {
      groups.push({ ...viewer, members: [viewer.id] });
      continue;
    }
    // Out of encoders: the nearest encode of the same codec, whatever its tier.
    const nearest = groups
      .filter((group) => group.codec === viewer.codec)
      .toSorted(
        (a, b) =>
          Math.abs(a.width * a.height - viewer.width * viewer.height) -
          Math.abs(b.width * b.height - viewer.width * viewer.height),
      )[0];
    nearest?.members.push(viewer.id);
  }
  const plan: VideoPlan = { encodes: [], viewers: new Map() };
  for (const group of groups) {
    const encode = encodeSettings(group.codec, group, group.tier);
    plan.encodes.push(encode);
    for (const member of group.members) plan.viewers.set(member, encode.key);
  }
  return plan;
}
