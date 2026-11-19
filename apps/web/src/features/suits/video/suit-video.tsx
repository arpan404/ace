import type { SuitDetail, SuitVideo } from "@ace/protocol/suits";
import { pickVideoSource, type ProbedVideo } from "@ace/suits";
import type { Scheme } from "@ace/themes";
import { useEffect, useRef, useState } from "react";
import { usePageVisible } from "@/lib/page-visibility.ts";
import { suitPalette } from "@/theme/suits/suit-css.ts";
import { watchSavingPower } from "../scene/power.ts";
import { timers } from "../scene/scene-backdrop.tsx";
import {
  createVideoController,
  positionKey,
  shouldPlay,
  storedPosition,
  type VideoController,
  type VideoFacts,
} from "./video-controller.ts";
import { readVideoFrame } from "./video-frame.ts";
import {
  createPaletteSampler,
  paletteColumns,
  paletteRows,
  videoTokenNames,
  videoTokens,
  type PaletteSampler,
} from "./video-palette.ts";
import { videoShowing } from "./video-showing.ts";

/*
 * A Suit's video behind the shell (ADR 0169): ace's own `<video>`, never the Suit's code. The
 * pure rules live in `video-controller.ts` (play, sound, position, failures) and
 * `video-palette.ts` (colours); this is the element, the page's facts and the root's tokens.
 */

export interface SuitVideoBackdropProps {
  suit: SuitDetail;
  video: SuitVideo;
  scheme: Scheme;
  /** Reduce motion: the frame holds, nothing plays. */
  still: boolean;
  /** The video failed for good; the Suit carries on without it. */
  onStopped(): void;
}

interface Source {
  path: string;
  url: string;
}

/** Each source's served URL, in suit.json's order; sources this page can't reach are left out. */
const servedSources = (suit: SuitDetail, video: SuitVideo): Source[] =>
  video.sources.flatMap((path) => {
    const url = suit.assets[path];
    return url ? [{ path, url }] : [];
  });

/** One file's own picture size, from its metadata; 0 × 0 when it can't be read. */
function probe(source: Source): Promise<ProbedVideo> {
  return new Promise((resolve) => {
    const element = document.createElement("video");
    element.preload = "metadata";
    element.muted = true;
    const done = (width: number, height: number) => {
      element.removeAttribute("src");
      element.load();
      resolve({ path: source.path, width, height });
    };
    element.addEventListener(
      "loadedmetadata",
      () => done(element.videoWidth, element.videoHeight),
      { once: true },
    );
    element.addEventListener("error", () => done(0, 0), { once: true });
    element.src = source.url;
  });
}

/** The window in device pixels. */
const deviceViewport = () => {
  const ratio = window.devicePixelRatio || 1;
  return {
    width: Math.round(window.innerWidth * ratio),
    height: Math.round(window.innerHeight * ratio),
  };
};

/** How long the window must hold still before the rendition is chosen again. */
export const viewportSettleMs = 400;

/**
 * The window's size in device pixels, kept current once it settles: a resize, full screen, or a
 * move to a display with another pixel ratio (which a resize event doesn't always report).
 */
function useDeviceViewport() {
  const [viewport, setViewport] = useState(deviceViewport);
  useEffect(() => {
    let cancel = () => {};
    let ratio: MediaQueryList | undefined;
    const settle = () => {
      cancel();
      cancel = timers.after(viewportSettleMs, () => {
        const next = deviceViewport();
        setViewport((now) => (now.width === next.width && now.height === next.height ? now : next));
        watchRatio();
      });
    };
    // A media query on the current ratio fires when the window moves to another display.
    const watchRatio = () => {
      ratio?.removeEventListener("change", settle);
      ratio = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      ratio?.addEventListener("change", settle);
    };
    watchRatio();
    window.addEventListener("resize", settle);
    return () => {
      cancel();
      window.removeEventListener("resize", settle);
      ratio?.removeEventListener("change", settle);
    };
  }, []);
  return viewport;
}

/**
 * The rendition to play: with one, that one; with several, each one's own size is read once,
 * and the pick follows the window: going full screen or to a sharper display moves up, a smaller
 * window moves down. A switch is a new element, which takes up the kept position.
 */
function usePickedSource(sources: readonly Source[], fit: SuitVideo["fit"]): Source | undefined {
  const key = sources.map((source) => source.url).join("\n");
  const [probed, setProbed] = useState<{ key: string; sizes: ProbedVideo[] }>();
  const several = sources.length > 1;
  const viewport = useDeviceViewport();
  const latest = useRef(sources);
  useEffect(() => {
    latest.current = sources;
  });
  useEffect(() => {
    if (!several) return;
    let live = true;
    void Promise.all(latest.current.map(probe)).then((sizes) => {
      if (live) setProbed({ key, sizes });
    });
    return () => {
      live = false;
    };
  }, [key, several]);
  if (!several) return sources[0];
  if (probed?.key !== key) return undefined;
  const best = pickVideoSource(probed.sizes, { ...viewport, fit });
  return sources.find((source) => source.path === best?.path) ?? sources.at(-1);
}

function useSavingPower(): boolean {
  const [saving, setSaving] = useState(false);
  useEffect(() => watchSavingPower(navigator, setSaving), []);
  return saving;
}

/** How much of the video the veil lets through, from the Suit's stylesheet. */
const appReveal = (root: HTMLElement) => {
  const value = Number.parseFloat(getComputedStyle(root).getPropertyValue("--suit-app-reveal"));
  return Number.isFinite(value) ? value : 0.65;
};

/** What the palette does: follow a playing video, hold one still frame's colour, or wait. */
const samplerMode = (facts: VideoFacts) =>
  shouldPlay(facts) ? "playing" : facts.still || facts.savingPower ? "still" : "paused";

/** Writes the colour the sampler shows onto the root's accent tokens and the veil. */
function useVideoTokens(suit: SuitDetail, video: SuitVideo, scheme: Scheme) {
  const colour = useRef<string | undefined>(undefined);
  const write = useRef<(colour: string | undefined) => void>(() => {});
  const { manifest } = suit;
  const { palette: follow } = video;
  useEffect(() => {
    const root = document.documentElement;
    const palette = suitPalette(manifest, scheme);
    write.current = (next) => {
      colour.current = next;
      const tokens = next
        ? videoTokens({ colour: next, scheme, palette, follow, reveal: appReveal(root) })
        : {};
      for (const name of videoTokenNames) {
        const value = tokens[name];
        if (value === undefined) root.style.removeProperty(name);
        else root.style.setProperty(name, value);
      }
    };
    // A scheme switch refits the colour already taken.
    write.current(colour.current);
  }, [manifest, scheme, follow]);
  useEffect(
    () => () => {
      for (const name of videoTokenNames) document.documentElement.style.removeProperty(name);
    },
    [],
  );
  return write;
}

export function SuitVideoBackdrop(props: SuitVideoBackdropProps) {
  const { suit, video, scheme, still, onStopped } = props;
  const picked = usePickedSource(servedSources(suit, video), video.fit);
  // With CORS the frame can be read for colours; a daemon that refuses it still plays the video.
  const [cors, setCors] = useState(true);
  const visible = usePageVisible();
  const savingPower = useSavingPower();
  const write = useVideoTokens(suit, video, scheme);
  const suitId = suit.summary.id;
  useEffect(() => () => videoShowing.clear(suitId), [suitId]);
  if (!picked) return null;
  return (
    <PlayingVideo
      // A new rendition or the CORS fallback is a new element, with its own controller.
      key={`${picked.url}\u0000${cors}`}
      suitId={suitId}
      url={picked.url}
      poster={video.poster ? suit.assets[video.poster] : undefined}
      cors={cors}
      video={video}
      facts={{ visible, still, savingPower }}
      show={(colour) => write.current(colour)}
      onCorsRefused={() => setCors(false)}
      onStopped={onStopped}
    />
  );
}

/**
 * One `<video>` element for one rendition, with the controller that plays it and the sampler
 * that reads its colours. A new read of the same Suit (a reconnect) keeps it and its position.
 */
function PlayingVideo(props: {
  suitId: string;
  url: string;
  poster: string | undefined;
  cors: boolean;
  video: SuitVideo;
  facts: VideoFacts;
  show(colour: string | undefined): void;
  onCorsRefused(): void;
  onStopped(): void;
}) {
  const { suitId, url, poster, cors, video, facts } = props;
  const element = useRef<HTMLVideoElement>(null);
  const controller = useRef<VideoController | undefined>(undefined);
  const sampler = useRef<PaletteSampler | undefined>(undefined);
  const loaded = useRef(false);
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });
  const { muted, volume } = video.audio;
  const { fit } = video;

  useEffect(() => {
    const node = element.current;
    if (!node) return;
    const made = createVideoController({
      element: node,
      audio: { muted, volume },
      position: storedPosition(globalThis.localStorage, positionKey(suitId)),
      after: timers.after,
      stopped: () => latest.current.onStopped(),
    });
    controller.current = made;
    made.facts(latest.current.facts);
    const gesture = () => made.gesture();
    // Leaving the page writes the position down.
    const leave = () => made.facts({ visible: false, still: false, savingPower: false });
    window.addEventListener("pointerdown", gesture, true);
    window.addEventListener("keydown", gesture, true);
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pointerdown", gesture, true);
      window.removeEventListener("keydown", gesture, true);
      window.removeEventListener("pagehide", leave);
      made.dispose();
      controller.current = undefined;
    };
  }, [suitId, muted, volume]);

  useEffect(() => {
    const node = element.current;
    if (!node || !cors) return;
    const made = createPaletteSampler({
      read: () => readVideoFrame(node, paletteColumns, paletteRows, fit)?.pixels,
      show: (colour) => latest.current.show(colour),
      after: timers.after,
    });
    sampler.current = made;
    made.run(samplerMode(latest.current.facts));
    return () => {
      made.dispose();
      sampler.current = undefined;
    };
  }, [cors, fit]);

  const { visible, still, savingPower } = facts;
  useEffect(() => {
    const now = { visible, still, savingPower };
    controller.current?.facts(now);
    sampler.current?.run(samplerMode(now));
  }, [visible, still, savingPower]);

  return (
    <video
      ref={element}
      src={url}
      poster={poster}
      crossOrigin={cors ? "anonymous" : undefined}
      preload="auto"
      loop
      playsInline
      disablePictureInPicture
      disableRemotePlayback
      aria-hidden="true"
      tabIndex={-1}
      data-suit-video=""
      data-fit={fit}
      className="pointer-events-none fixed inset-0 -z-10 size-full"
      style={{ objectFit: fit }}
      onLoadedMetadata={(event) => {
        loaded.current = true;
        const node = event.currentTarget;
        videoShowing.set(suitId, { width: node.videoWidth, height: node.videoHeight });
        controller.current?.loaded();
      }}
      onLoadedData={() => {
        // The first frame is there: a still Suit takes its colour from it.
        const now = latest.current.facts;
        if (!shouldPlay(now)) sampler.current?.run(samplerMode(now));
      }}
      onTimeUpdate={() => controller.current?.progressed(performance.now())}
      onError={() => {
        // Refused before any metadata with CORS on: try once more without it (no colours).
        if (cors && !loaded.current) latest.current.onCorsRefused();
        else controller.current?.failed();
      }}
    />
  );
}
