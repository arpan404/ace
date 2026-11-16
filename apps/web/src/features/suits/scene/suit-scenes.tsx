import { SceneSignal, type SuitDetail } from "@ace/protocol/suits";
import type { SuitSceneRegion } from "@ace/protocol/suit-parts";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { z } from "zod";
import { documentVisibility } from "@/lib/page-visibility.ts";
import { useTheme } from "@/theme/theme-provider.tsx";
import { celebrationCue, createCelebrationGate, type CelebrationCue } from "./celebration.ts";
import { CelebrationLayer } from "./celebration-layer.tsx";
import { clock, SceneBackdrop, timers, type SignalFeed } from "./scene-backdrop.tsx";
import { createSceneBeat, type SceneFrames } from "./scene-beat.ts";
import type { SceneStop } from "./scene-controller.ts";
import { sceneSignals } from "./scene-signals.ts";
import { noStops, sceneFrame, withStop, type SceneStops } from "./scene-stops.ts";
import { useSignalChanges } from "./use-scene-signals.ts";

/*
 * Every scene on the page (ADR 0150, "Scenes per region"): the app's backdrop and one per region
 * (sidebar, header, composer) the Suit names. They share one clock (`createSceneBeat`: 30 frames
 * a second between them), one feed of thread signals, and the stop rules of `scene-stops.ts`
 * (by version of the Suit, not by URL); each keeps its own watchdog and pause rules.
 *
 * A Suit's `celebration` scene is not a region's backdrop: it plays above the UI for a moment
 * when the open thread's run finishes or a pull request merges (`celebration.ts`).
 */

interface ScenesValue {
  frames: SceneFrames;
  signals: SignalFeed;
  /** The frame `region`'s scene runs in for this read of the Suit, or null while it's down. */
  frame(suit: SuitDetail, region: SuitSceneRegion): string | null;
  stop(suit: SuitDetail, region: SuitSceneRegion, why: SceneStop): void;
}
const ScenesContext = createContext<ScenesValue | undefined>(undefined);

/** A feed that hands each signal to whoever is watching. */
function signalFeed(): SignalFeed & { send(signal: SceneSignal): void } {
  const watchers = new Set<(signal: SceneSignal) => void>();
  return {
    watch(send) {
      watchers.add(send);
      return () => void watchers.delete(send);
    },
    send(signal) {
      for (const watcher of watchers) watcher(signal);
    },
  };
}

/** A development build's way to fire a signal by hand: `postMessage` it from the page itself. */
const DevSignal = z.object({ type: z.literal("ace-dev-scene-signal"), signal: SceneSignal });

/**
 * Reads the live thread list for signals, only while some scene could hear them, and for the
 * cues a celebration plays on.
 */
function SignalSource(props: {
  send(signal: SceneSignal): void;
  celebrate(cue: CelebrationCue): void;
  openThreadId: string | undefined;
}) {
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });
  useSignalChanges((previous, next) => {
    for (const signal of sceneSignals(previous, next)) latest.current.send(signal);
    const cue = celebrationCue(previous, next, latest.current.openThreadId);
    if (cue) latest.current.celebrate(cue);
  });
  useEffect(() => {
    // Only in a development build: lets a person or agent see a Suit's reactions without
    // finishing a run or merging a pull request. Production builds drop this branch.
    if (!import.meta.env.DEV) return;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const parsed = DevSignal.safeParse(event.data);
      if (!parsed.success) return;
      const { signal } = parsed.data;
      latest.current.send(signal);
      if (signal === "done" || signal === "pr-merged") latest.current.celebrate(signal);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return null;
}

export function SuitScenesProvider(props: {
  children: ReactNode;
  /** The thread on screen: its run finishing is what `done` celebrates. */
  openThreadId?: string | undefined;
}) {
  const { suit, resolved } = useTheme();
  const [frames] = useState(() => createSceneBeat({ clock, scheduler: timers }));
  const [feed] = useState(signalFeed);
  const [stops, setStops] = useState<SceneStops>(noStops);
  const frame = useCallback(
    (detail: SuitDetail, region: SuitSceneRegion) => sceneFrame(stops, detail, region),
    [stops],
  );
  const stop = useCallback((detail: SuitDetail, region: SuitSceneRegion, why: SceneStop) => {
    const reason = why.reason === "error" ? `${why.reason}: ${why.message}` : why.reason;
    console.warn(`[suits] ${detail.summary.id}'s ${region} scene was stopped (${reason})`);
    setStops((known) => withStop(known, detail, region, why));
  }, []);
  const value = useMemo(
    () => ({ frames, signals: feed, frame, stop }),
    [frames, feed, frame, stop],
  );
  const anyScene =
    suit !== null && Object.keys(suit.sceneUrls).length + (suit.sceneUrl ? 1 : 0) > 0;

  const celebrationUrl =
    suit?.sceneUrls.celebration && frame(suit, "celebration") !== null
      ? suit.sceneUrls.celebration
      : null;
  const [gate] = useState(() => createCelebrationGate(clock));
  const [playing, setPlaying] = useState<{ cue: CelebrationCue; turn: number } | null>(null);
  const facts = useRef({ hasScene: false, reduceMotion: false });
  useEffect(() => {
    facts.current = {
      hasScene: celebrationUrl !== null,
      reduceMotion: resolved.backdropMotion === "still",
    };
  });
  const celebrate = useCallback(
    (cue: CelebrationCue) => {
      if (!gate.admit({ ...facts.current, visible: documentVisibility.visible() })) return;
      setPlaying((now) => ({ cue, turn: (now?.turn ?? 0) + 1 }));
    },
    [gate],
  );
  const ended = useCallback(() => setPlaying(null), []);
  // A celebration cut short by a still backdrop or a new Suit doesn't come back when it lifts.
  const mayPlay = celebrationUrl !== null && resolved.backdropMotion !== "still";
  if (!mayPlay && playing) setPlaying(null);
  return (
    <ScenesContext.Provider value={value}>
      {anyScene && (
        <SignalSource send={feed.send} celebrate={celebrate} openThreadId={props.openThreadId} />
      )}
      {props.children}
      {/* Gone the moment Reduce motion turns on or the Suit (or its scene) goes away. */}
      {playing && suit && celebrationUrl && mayPlay && (
        <CelebrationLayer
          key={playing.turn}
          sceneUrl={celebrationUrl}
          cue={playing.cue}
          scheme={resolved.scheme}
          frames={frames}
          onEnd={ended}
          onStopped={(why) => stop(suit, "celebration", why)}
        />
      )}
    </ScenesContext.Provider>
  );
}

/**
 * The scene URL `region` runs now, or null: none named, stopped, or no provider; and the frame it
 * runs in (`scene-stops.ts`), which a new read of the same version doesn't change.
 */
export function useRegionScene(region: SuitSceneRegion) {
  const scenes = useContext(ScenesContext);
  const { suit, resolved } = useTheme();
  const url = region === "app" ? (suit?.sceneUrl ?? suit?.sceneUrls.app) : suit?.sceneUrls[region];
  const frame = scenes && suit && url ? scenes.frame(suit, region) : null;
  return { scenes, suit, resolved, url: frame === null ? null : (url ?? null), frame };
}

/**
 * A region's own scene (`scenes.sidebar`, `.header`, `.composer`), filling the positioned region
 * it is mounted in, under its content. Renders nothing without one.
 */
export function RegionScene(props: { region: Exclude<SuitSceneRegion, "app"> }) {
  const { scenes, suit, resolved, url, frame } = useRegionScene(props.region);
  if (!scenes || !suit || !url || !frame) return null;
  return (
    <SceneBackdrop
      sceneUrl={url}
      frame={frame}
      scheme={resolved.scheme}
      reduceMotion={resolved.backdropMotion === "still"}
      halfRate={resolved.backdropMotion === "reduced"}
      signals={scenes.signals}
      frames={scenes.frames}
      fill="region"
      region={props.region}
      onStopped={(why) => scenes.stop(suit, props.region, why)}
    />
  );
}
