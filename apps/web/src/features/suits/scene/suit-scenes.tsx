import type { SceneSignal, SuitDetail } from "@ace/protocol/suits";
import type { SuitSceneRegion } from "@ace/protocol/suit-parts";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useTheme } from "@/theme/theme-provider.tsx";
import { clock, SceneBackdrop, timers, type SignalFeed } from "./scene-backdrop.tsx";
import { createSceneBeat, type SceneFrames } from "./scene-beat.ts";
import type { SceneStop } from "./scene-controller.ts";
import { useSceneSignals } from "./use-scene-signals.ts";

/*
 * Every scene on the page (ADR 0150, "Scenes per region"): the app's backdrop and one per region
 * (sidebar, header, composer) the Suit names. They share one clock (`createSceneBeat`: 30 frames
 * a second between them), one feed of thread signals, and the rule that a scene the watchdog
 * stops stays down for that version of the Suit; each keeps its own watchdog and pause rules.
 */

interface ScenesValue {
  frames: SceneFrames;
  signals: SignalFeed;
  /** Whether `region`'s scene of this version of the Suit was stopped. */
  stopped(suit: SuitDetail, region: SuitSceneRegion): boolean;
  stop(suit: SuitDetail, region: SuitSceneRegion, why: SceneStop): void;
}
const ScenesContext = createContext<ScenesValue | undefined>(undefined);

/** One version of one Suit's scene in one region. */
const sceneKey = (suit: SuitDetail, region: SuitSceneRegion) =>
  `${suit.summary.id}\u0000${suit.summary.contentHash}\u0000${region}`;

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

/** Reads the live thread list for signals, only while some scene could hear them. */
function SignalSource(props: { send(signal: SceneSignal): void }) {
  useSceneSignals(props.send);
  return null;
}

export function SuitScenesProvider(props: { children: ReactNode }) {
  const { suit } = useTheme();
  const [frames] = useState(() => createSceneBeat({ clock, scheduler: timers }));
  const [feed] = useState(signalFeed);
  const [stoppedKeys, setStoppedKeys] = useState<ReadonlySet<string>>(new Set());
  const stopped = useCallback(
    (detail: SuitDetail, region: SuitSceneRegion) => stoppedKeys.has(sceneKey(detail, region)),
    [stoppedKeys],
  );
  const stop = useCallback((detail: SuitDetail, region: SuitSceneRegion, why: SceneStop) => {
    const reason = why.reason === "error" ? `${why.reason}: ${why.message}` : why.reason;
    console.warn(`[suits] ${detail.summary.id}'s ${region} scene was stopped (${reason})`);
    setStoppedKeys((known) => new Set(known).add(sceneKey(detail, region)));
  }, []);
  const value = useMemo(
    () => ({ frames, signals: feed, stopped, stop }),
    [frames, feed, stopped, stop],
  );
  const anyScene =
    suit !== null && Object.keys(suit.sceneUrls).length + (suit.sceneUrl ? 1 : 0) > 0;
  return (
    <ScenesContext.Provider value={value}>
      {anyScene && <SignalSource send={feed.send} />}
      {props.children}
    </ScenesContext.Provider>
  );
}

/** The scene URL `region` runs now, or null: none named, stopped, or no provider. */
export function useRegionScene(region: SuitSceneRegion) {
  const scenes = useContext(ScenesContext);
  const { suit, resolved } = useTheme();
  const url = region === "app" ? (suit?.sceneUrl ?? suit?.sceneUrls.app) : suit?.sceneUrls[region];
  const live = scenes && suit && url && !scenes.stopped(suit, region) ? url : null;
  return { scenes, suit, resolved, url: live };
}

/**
 * A region's own scene (`scenes.sidebar`, `.header`, `.composer`), filling the positioned region
 * it is mounted in, under its content. Renders nothing without one.
 */
export function RegionScene(props: { region: Exclude<SuitSceneRegion, "app"> }) {
  const { scenes, suit, resolved, url } = useRegionScene(props.region);
  if (!scenes || !suit || !url) return null;
  return (
    <SceneBackdrop
      sceneUrl={url}
      scheme={resolved.scheme}
      reduceMotion={resolved.reduceMotion}
      signals={scenes.signals}
      frames={scenes.frames}
      fill="region"
      region={props.region}
      onStopped={(why) => scenes.stop(suit, props.region, why)}
    />
  );
}
