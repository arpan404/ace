import type { SceneSignal } from "@ace/protocol/suits";
import { useState } from "react";
import { SceneBackdrop, type SignalFeed, type SuitBackdropProps } from "./scene-backdrop.tsx";
import { useSceneSignals } from "./use-scene-signals.ts";

export type { SuitBackdropProps } from "./scene-backdrop.tsx";

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

/**
 * The Suit's scene behind the app (`SceneBackdrop`), fed with the live thread list's signals.
 * Renders nothing, and reads nothing, for a Suit without a scene.
 */
export function SuitBackdrop(props: SuitBackdropProps) {
  if (!props.sceneUrl) return null;
  return <LiveSceneBackdrop {...props} />;
}

function LiveSceneBackdrop(props: SuitBackdropProps) {
  const [feed] = useState(signalFeed);
  useSceneSignals(feed.send);
  return <SceneBackdrop {...props} signals={feed} />;
}
