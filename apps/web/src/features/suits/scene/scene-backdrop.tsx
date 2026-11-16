import type { SceneHostMessage, SceneSignal } from "@ace/protocol/suits";
import type { SuitSceneRegion } from "@ace/protocol/suit-parts";
import { useEffect, useRef, useState } from "react";
import { documentVisibility } from "@/lib/page-visibility.ts";
import { watchSavingPower } from "./power.ts";
import type { SceneFrames } from "./scene-beat.ts";
import {
  createSceneController,
  messageFromScene,
  type SceneController,
  type SceneStop,
  type SceneViewport,
  type Scheme,
} from "./scene-controller.ts";
import { watchSceneGlass } from "./scene-glass.ts";

/** Where thread signals come from; `watch` returns the unsubscribe. */
export interface SignalFeed {
  watch(send: (signal: SceneSignal) => void): () => void;
}

export interface SuitBackdropProps {
  /** The Suit's scene page (`SuitDetail.sceneUrl`); null for a Suit without a scene. */
  sceneUrl: string | null;
  scheme: Scheme;
  reduceMotion: boolean;
  /** Reduced backdrop motion: the scene ticks at half the rate. */
  halfRate?: boolean | undefined;
  /** The scene failed and was taken down; the Suit carries on with its colours alone. */
  onStopped?: ((stop: SceneStop, sceneUrl: string) => void) | undefined;
}

export interface SceneBackdropProps extends SuitBackdropProps {
  /**
   * Which frame the scene runs in (`scene-stops.ts`), when not one per URL: while it stays the
   * same, a running scene keeps the page it loaded and a new `sceneUrl` doesn't reload it.
   */
  frame?: string | undefined;
  signals: SignalFeed;
  /** The page's shared clock, when several scenes run (`createSceneBeat`). */
  frames?: SceneFrames | undefined;
  /**
   * `window`: full-bleed behind the app (the app's scene). `region`: filling the positioned
   * region it is mounted in (the sidebar's, the header's, the composer's), sized to it.
   * `above`: full-window over the app, transparent where it draws nothing (a celebration); no
   * glass, and the live check never samples it as a backdrop.
   */
  fill?: "window" | "region" | "above" | undefined;
  /** The region a region scene runs in (`regionSceneOpacity` sets how much of it shows). */
  region?: SuitSceneRegion | undefined;
  /** A signal the scene hears as soon as it is ready (what woke a celebration). */
  wake?: SceneSignal | undefined;
  /** The scene said it has played out (`ace.finish()`). */
  onFinished?: (() => void) | undefined;
}

/**
 * A Suit's animated backdrop: its scene in a sandboxed, opaque-origin frame, full-bleed behind
 * the app, never hit by the pointer and hidden from assistive tech. ace drives its clock
 * (`createSceneController`); a scene the watchdog stops is unmounted and stays down until its
 * frame (by default, its URL) changes.
 */
export function SceneBackdrop(props: SceneBackdropProps) {
  const [stoppedFrame, setStoppedFrame] = useState<string | null>(null);
  const { sceneUrl, onStopped } = props;
  const frame = props.frame ?? sceneUrl;
  if (!sceneUrl || !frame || stoppedFrame === frame) return null;
  return (
    <SceneFrame
      key={frame}
      sceneUrl={sceneUrl}
      scheme={props.scheme}
      reduceMotion={props.reduceMotion}
      halfRate={props.halfRate ?? false}
      signals={props.signals}
      frames={props.frames}
      fill={props.fill ?? "window"}
      region={props.region}
      wake={props.wake}
      finished={() => props.onFinished?.()}
      stopped={(stop) => {
        setStoppedFrame(frame);
        onStopped?.(stop, sceneUrl);
      }}
    />
  );
}

/**
 * How much of a region's own scene shows over the region's surface: the Suit's
 * `--suit-<region>-scene-opacity` from suit.css, else the region's reveal
 * (`--suit-<region>-reveal`, the Suit's `reveal` held to what keeps the text readable;
 * theme/suits/suit-layers.ts). The scene paints over the surface, so this is the surface
 * drawn at `1 - reveal` over it.
 */
export const regionSceneOpacity = (region: string) =>
  `var(--suit-${region}-scene-opacity, var(--suit-${region}-reveal, 1))`;

/** The window's size in CSS pixels and its pixel ratio, capped at 2 to bound fill cost. */
export function windowViewport(
  view: Pick<Window, "innerWidth" | "innerHeight" | "devicePixelRatio">,
): SceneViewport {
  return {
    width: view.innerWidth,
    height: view.innerHeight,
    pixelRatio: Math.min(2, view.devicePixelRatio || 1),
  };
}

/** The page's timers and clock: the I/O edge every scene's controller and the shared beat use. */
export const timers = {
  after(ms: number, run: () => void) {
    const id = window.setTimeout(run, ms);
    return () => window.clearTimeout(id);
  },
};
export const clock = { now: () => performance.now() };

/** A region's size in CSS pixels, with the window's pixel ratio capped as `windowViewport` does. */
const regionViewport = (element: Element): SceneViewport => {
  const box = element.getBoundingClientRect();
  return { width: box.width, height: box.height, pixelRatio: windowViewport(window).pixelRatio };
};

function SceneFrame(props: {
  sceneUrl: string;
  scheme: Scheme;
  reduceMotion: boolean;
  halfRate: boolean;
  signals: SignalFeed;
  frames: SceneFrames | undefined;
  fill: "window" | "region" | "above";
  region: SuitSceneRegion | undefined;
  wake: SceneSignal | undefined;
  finished: () => void;
  stopped: (stop: SceneStop) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  // The page this frame loaded: a later URL for the same frame (a reconnect's read of the same
  // version) must not navigate it, or the scene would start over.
  const [src] = useState(props.sceneUrl);
  // The page's load, heard from the moment the frame exists: a cached page can finish loading
  // before the effect below runs, and a listener added there would never hear it.
  const loadedEarly = useRef(false);
  const onPageLoad = useRef<(() => void) | undefined>(undefined);
  const controller = useRef<SceneController>(undefined);
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    // Messages wait for the page and its runtime. The scene starts (init, and its 3 s to be
    // ready) once the page has loaded, so a slow first load of the app isn't held against it.
    let loaded = false;
    const queued: SceneHostMessage[] = [];
    const post = (message: SceneHostMessage) => {
      if (!loaded) queued.push(message);
      else element.contentWindow?.postMessage(message, "*");
    };
    const onLoad = () => {
      loaded = true;
      for (const message of queued.splice(0)) element.contentWindow?.postMessage(message, "*");
      scene.start();
    };
    const { scheme, reduceMotion, halfRate, frames, fill, region, wake } = latest.current;
    const viewport = () => (fill === "region" ? regionViewport(element) : windowViewport(window));
    const scene = createSceneController(
      {
        ...viewport(),
        scheme,
        reduceMotion,
        halfRate,
        visible: documentVisibility.visible(),
        focused: document.hasFocus(),
        lowPower: false,
        region,
        wake,
      },
      {
        clock,
        scheduler: timers,
        post,
        frames,
        stopped: (stop) => latest.current.stopped(stop),
        finished: () => latest.current.finished(),
      },
    );
    controller.current = scene;
    onPageLoad.current = onLoad;
    if (loadedEarly.current) onLoad();
    const onMessage = (event: MessageEvent) => {
      const message = messageFromScene(event, element.contentWindow);
      if (message) scene.receive(message);
    };
    const onFocus = () => scene.setFocused(true);
    const onBlur = () => scene.setFocused(false);
    const onResize = () => scene.resize(viewport());
    const regionSize =
      fill === "region" && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(onResize)
        : undefined;
    regionSize?.observe(element);
    window.addEventListener("message", onMessage);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onResize);
    const unwatchVisibility = documentVisibility.watch(() =>
      scene.setVisible(documentVisibility.visible()),
    );
    const unwatchPower = watchSavingPower(navigator, (saving) => scene.setLowPower(saving));
    // The app's scene sits behind ace's glass, which can't blur into this frame: the runtime
    // blurs the scene under it instead (scene-glass.ts).
    const unwatchGlass = fill === "window" ? watchSceneGlass(element, post) : undefined;
    return () => {
      unwatchGlass?.();
      scene.dispose();
      controller.current = undefined;
      onPageLoad.current = undefined;
      window.removeEventListener("message", onMessage);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onResize);
      regionSize?.disconnect();
      unwatchVisibility();
      unwatchPower();
    };
  }, []);

  useEffect(() => controller.current?.setScheme(props.scheme), [props.scheme]);
  useEffect(() => controller.current?.setReduceMotion(props.reduceMotion), [props.reduceMotion]);
  useEffect(() => controller.current?.setHalfRate(props.halfRate), [props.halfRate]);
  const { signals } = props;
  useEffect(() => signals.watch((signal) => controller.current?.signal(signal)), [signals]);

  return (
    <iframe
      ref={frame}
      src={src}
      onLoad={() => {
        if (onPageLoad.current) onPageLoad.current();
        else loadedEarly.current = true;
      }}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      title="Suit scene"
      // Where the live check finds each backdrop to sample (`live/scene-sample.ts`); a scene
      // above the UI is no text's backdrop.
      data-suit-scene-frame={props.fill === "above" ? undefined : (props.region ?? "app")}
      data-suit-celebration-frame={props.fill === "above" ? "" : undefined}
      aria-hidden="true"
      tabIndex={-1}
      data-scene-fill={props.fill}
      style={
        props.fill === "above"
          ? // A frame is drawn on an opaque canvas unless its page and its element agree on a
            // colour scheme: the scene page names `light dark` (daemon suits/http.ts), so the
            // element names none and stays clear over the UI in either scheme.
            { colorScheme: "normal" }
          : props.region
            ? { opacity: regionSceneOpacity(props.region) }
            : undefined
      }
      className={
        props.fill === "region"
          ? "pointer-events-none absolute inset-0 -z-10 h-full w-full rounded-[inherit] border-0 bg-transparent"
          : props.fill === "above"
            ? "pointer-events-none fixed inset-0 h-full w-full border-0 bg-transparent"
            : "pointer-events-none fixed inset-0 -z-10 h-full w-full border-0 bg-transparent"
      }
    />
  );
}
