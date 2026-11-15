import { useEffect } from "react";
import { SceneBackdrop } from "./scene-backdrop.tsx";
import { useRegionScene } from "./suit-scenes.tsx";

/**
 * The applied Suit's app scene behind the shell (ADR 0150), in the scheme and motion on screen,
 * on the page's shared clock (`SuitScenesProvider`). A scene the watchdog stops is turned off for
 * that version of the Suit, which carries on with its colours; an edit to the Suit (a new
 * content hash) gets its scene back. Reconnecting gives the scene a new URL (a new daemon run's
 * grant) but not a new version, so it stays off.
 */
export function AppliedSuitBackdrop(props: {
  /** Whether a scene draws now, so the shell can let it show through. */
  onShowing(showing: boolean): void;
}) {
  const { scenes, suit, resolved, url } = useRegionScene("app");
  const { onShowing } = props;
  const showing = url !== null;
  useEffect(() => {
    onShowing(showing);
  }, [onShowing, showing]);

  if (!scenes || !suit || !url) return null;
  return (
    <>
      <SceneBackdrop
        sceneUrl={url}
        scheme={resolved.scheme}
        reduceMotion={resolved.reduceMotion}
        signals={scenes.signals}
        frames={scenes.frames}
        onStopped={(why) => scenes.stop(suit, "app", why)}
      />
      {/*
        The frame's colour over the scene, so the rail's and top bar's text keeps its contrast:
        it lets `--suit-app-reveal` of the scene through (the Suit's `reveal.app`, held to what
        reads; theme/suits/suit-layers.ts).
      */}
      <div
        aria-hidden="true"
        data-suit-veil=""
        className="pointer-events-none fixed inset-0 -z-10 bg-sidebar"
        style={{ opacity: "calc(1 - var(--suit-app-reveal, 0.65))" }}
      />
    </>
  );
}
