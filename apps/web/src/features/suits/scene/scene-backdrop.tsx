import type { SceneHostMessage, SceneSignal } from "@ace/protocol/suits";
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

/** Where thread signals come from; `watch` returns the unsubscribe. */
export interface SignalFeed {
  watch(send: (signal: SceneSignal) => void): () => void;
}

export interface SuitBackdropProps {
  /** The Suit's scene page (`SuitDetail.sceneUrl`); null for a Suit without a scene. */
  sceneUrl: string | null;
  scheme: Scheme;
  reduceMotion: boolean;
  /** The scene failed and was taken down; the Suit carries on with its colours alone. */
  onStopped?: ((stop: SceneStop, sceneUrl: string) => void) | undefined;
}

export interface SceneBackdropProps extends SuitBackdropProps {
  signals: SignalFeed;
  /** The page's shared clock, when several scenes run (`createSceneBeat`). */
  frames?: SceneFrames | undefined;
  /**
   * `window`: full-bleed behind the app (the app's scene). `region`: filling the positioned
   * region it is mounted in (the sidebar's, the header's, the composer's), sized to it.
   */
  fill?: "window" | "region" | undefined;
  /** The region a region scene runs in (`regionSceneOpacity` sets how much of it shows). */
  region?: string | undefined;
}

/**
 * A Suit's animated backdrop: its scene in a sandboxed, opaque-origin frame, full-bleed behind
 * the app, never hit by the pointer and hidden from assistive tech. ace drives its clock
 * (`createSceneController`); a scene the watchdog stops is unmounted and stays down until the
 * scene URL changes.
 */
export function SceneBackdrop(props: SceneBackdropProps) {
  const [stoppedUrl, setStoppedUrl] = useState<string | null>(null);
  const { sceneUrl, onStopped } = props;
  if (!sceneUrl || stoppedUrl === sceneUrl) return null;
  return (
    <SceneFrame
      key={sceneUrl}
      sceneUrl={sceneUrl}
      scheme={props.scheme}
      reduceMotion={props.reduceMotion}
      signals={props.signals}
      frames={props.frames}
      fill={props.fill ?? "window"}
      region={props.region}
      stopped={(stop) => {
        setStoppedUrl(sceneUrl);
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
  signals: SignalFeed;
  frames: SceneFrames | undefined;
  fill: "window" | "region";
  region: string | undefined;
  stopped: (stop: SceneStop) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const controller = useRef<SceneController>(undefined);
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    // Messages wait for the page and its runtime; the ready deadline runs from mount.
    let loaded = false;
    const queued: SceneHostMessage[] = [];
    const post = (message: SceneHostMessage) => {
      if (!loaded) queued.push(message);
      else element.contentWindow?.postMessage(message, "*");
    };
    const onLoad = () => {
      loaded = true;
      for (const message of queued.splice(0)) element.contentWindow?.postMessage(message, "*");
    };
    const { scheme, reduceMotion, frames, fill } = latest.current;
    const viewport = () => (fill === "region" ? regionViewport(element) : windowViewport(window));
    const scene = createSceneController(
      {
        ...viewport(),
        scheme,
        reduceMotion,
        visible: documentVisibility.visible(),
        focused: document.hasFocus(),
        lowPower: false,
      },
      { clock, scheduler: timers, post, frames, stopped: (stop) => latest.current.stopped(stop) },
    );
    controller.current = scene;
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
    element.addEventListener("load", onLoad);
    window.addEventListener("message", onMessage);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onResize);
    const unwatchVisibility = documentVisibility.watch(() =>
      scene.setVisible(documentVisibility.visible()),
    );
    const unwatchPower = watchSavingPower(navigator, (saving) => scene.setLowPower(saving));
    scene.start();
    return () => {
      scene.dispose();
      controller.current = undefined;
      element.removeEventListener("load", onLoad);
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
  const { signals } = props;
  useEffect(() => signals.watch((signal) => controller.current?.signal(signal)), [signals]);

  return (
    <iframe
      ref={frame}
      src={props.sceneUrl}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      title="Suit scene"
      // Where the live check finds each scene to sample (`live/scene-sample.ts`).
      data-suit-scene-frame={props.region ?? "app"}
      aria-hidden="true"
      tabIndex={-1}
      data-scene-fill={props.fill}
      style={props.region ? { opacity: regionSceneOpacity(props.region) } : undefined}
      className={
        props.fill === "region"
          ? "pointer-events-none absolute inset-0 -z-10 h-full w-full rounded-[inherit] border-0 bg-transparent"
          : "pointer-events-none fixed inset-0 -z-10 h-full w-full border-0 bg-transparent"
      }
    />
  );
}
