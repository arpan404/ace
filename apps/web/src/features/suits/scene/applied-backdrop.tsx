import { useEffect, useState } from "react";
import { useTheme } from "@/theme/theme-provider.tsx";
import type { SceneStop } from "./scene-controller.ts";
import { SuitBackdrop } from "./suit-backdrop.tsx";

/** One version of one Suit: a stopped scene stays down until the Suit's content changes. */
const versionOf = (suit: { summary: { id: string; contentHash: string } }) =>
  `${suit.summary.id}\u0000${suit.summary.contentHash}`;

/**
 * The applied Suit's scene behind the shell (ADR 0150), in the scheme and motion on screen. A
 * scene the watchdog stops is turned off for that version of the Suit, which carries on with its
 * colours; an edit to the Suit (a new content hash) gets its scene back. Reconnecting gives the
 * scene a new URL (a new daemon run's grant) but not a new version, so it stays off.
 */
export function AppliedSuitBackdrop(props: {
  /** Whether a scene draws now, so the shell can let it show through. */
  onShowing(showing: boolean): void;
}) {
  const { suit, resolved } = useTheme();
  const [stopped, setStopped] = useState<ReadonlySet<string>>(new Set());
  const version = suit ? versionOf(suit) : undefined;
  const sceneUrl = suit && version && !stopped.has(version) ? suit.sceneUrl : null;

  const { onShowing } = props;
  const showing = sceneUrl !== null;
  useEffect(() => {
    onShowing(showing);
  }, [onShowing, showing]);

  if (!sceneUrl || !version) return null;
  const onStopped = (stop: SceneStop) => {
    const detail = stop.reason === "error" ? `: ${stop.message}` : "";
    console.warn(
      `[suits] ${suit?.summary.id ?? "a Suit"}'s scene was stopped (${stop.reason}${detail})`,
    );
    setStopped((known) => new Set(known).add(version));
  };
  return (
    <>
      <SuitBackdrop
        sceneUrl={sceneUrl}
        scheme={resolved.scheme}
        reduceMotion={resolved.reduceMotion}
        onStopped={onStopped}
      />
      {/* The frame's colour over the scene, so the sidebar's text keeps its contrast. */}
      <div
        aria-hidden="true"
        data-suit-veil=""
        className="pointer-events-none fixed inset-0 -z-10 bg-sidebar/35"
      />
    </>
  );
}
