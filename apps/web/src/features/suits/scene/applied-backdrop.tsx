import { useEffect, useState } from "react";
import { SuitVideoBackdrop } from "../video/suit-video.tsx";
import { SceneBackdrop } from "./scene-backdrop.tsx";
import { useRegionScene } from "./suit-scenes.tsx";

/**
 * The applied Suit's app scene behind the shell (ADR 0150), in the scheme and motion on screen,
 * on the page's shared clock (`SuitScenesProvider`). A scene the watchdog stops is turned off for
 * that version of the Suit, which carries on with its colours; an edit to the Suit (a new
 * content hash) gets its scene back. A reconnect reads the same version again: a running scene
 * carries on in its frame, and one that never loaded gets another go (`scene-stops.ts`).
 *
 * A Suit with a video (ADR 0169) shows that instead, in ace's own element; one that fails for good
 * is dropped for that version, the same way.
 */
export function AppliedSuitBackdrop(props: {
  /** Whether a scene draws now, so the shell can let it show through. */
  onShowing(showing: boolean): void;
}) {
  const { scenes, suit, resolved, url, frame } = useRegionScene("app");
  const shown = suit;
  const [videoStopped, setVideoStopped] = useState<string | null>(null);
  const video = shown?.manifest.video;
  const videoVersion = shown ? `${shown.summary.id}\u0000${shown.summary.contentHash}` : null;
  const videoShows =
    shown !== null &&
    video !== undefined &&
    videoStopped !== videoVersion &&
    video.sources.some((path) => shown.assets[path] !== undefined);
  const { onShowing } = props;
  const showing = videoShows || url !== null;
  useEffect(() => {
    onShowing(showing);
  }, [onShowing, showing]);

  if (videoShows && shown && video) {
    return (
      <>
        <SuitVideoBackdrop
          suit={shown}
          video={video}
          scheme={resolved.scheme}
          still={resolved.backdropMotion === "still"}
          onStopped={() => {
            console.warn(`[suits] ${shown.summary.id}'s video was stopped after repeated failures`);
            setVideoStopped(videoVersion);
          }}
        />
        {/* The veil, tinted by the picture's colour within what keeps the frame's text readable. */}
        <div
          aria-hidden="true"
          data-suit-veil=""
          className="pointer-events-none fixed inset-0 -z-10"
          style={{
            background: "var(--suit-video-veil, var(--sidebar))",
            opacity: "calc(1 - var(--suit-app-reveal, 0.65))",
          }}
        />
      </>
    );
  }
  if (!scenes || !suit || !url || !frame) return null;
  return (
    <>
      <SceneBackdrop
        sceneUrl={url}
        frame={frame}
        scheme={resolved.scheme}
        reduceMotion={resolved.backdropMotion === "still"}
        halfRate={resolved.backdropMotion === "reduced"}
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
