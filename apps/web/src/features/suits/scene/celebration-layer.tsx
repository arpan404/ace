import { protectedSuitParts } from "@ace/protocol/suit-parts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SceneBackdrop, type SignalFeed } from "./scene-backdrop.tsx";
import type { SceneFrames } from "./scene-beat.ts";
import type { SceneStop, Scheme } from "./scene-controller.ts";
import {
  celebrationClip,
  celebrationMaxMs,
  celebrationMeasureMs,
  type CelebrationCue,
} from "./celebration.ts";

/** A celebration hears only what woke it (`wake`), never the signals after. */
const quiet: SignalFeed = { watch: () => () => {} };

const protectedSelector = protectedSuitParts.map((name) => `[data-part="${name}"]`).join(",");

/** The window less a hole around every protected part on the page now. */
function measureClip(document: Document): string {
  const view = document.defaultView;
  if (!view) return "none";
  const boxes = [...document.querySelectorAll(protectedSelector)].map((element) =>
    element.getBoundingClientRect(),
  );
  return celebrationClip(boxes, { width: view.innerWidth, height: view.innerHeight });
}

/**
 * A Suit's celebration playing over the whole window (`celebration.ts` has the rules): its scene
 * in the sandboxed frame, above every other layer, never hit by the pointer, with a hole cut
 * around each protected part, measured again every 100 ms while it plays. It ends when the scene
 * says it has played out, after `celebrationMaxMs` at the latest, or if the watchdog stops it;
 * its parent unmounts it then.
 */
export function CelebrationLayer(props: {
  sceneUrl: string;
  cue: CelebrationCue;
  scheme: Scheme;
  frames: SceneFrames;
  onEnd(): void;
  onStopped(why: SceneStop): void;
}) {
  const [clip, setClip] = useState("none");
  const end = useRef(props.onEnd);
  useEffect(() => {
    end.current = props.onEnd;
  });
  useLayoutEffect(() => {
    const measure = () => setClip(measureClip(document));
    measure();
    const every = window.setInterval(measure, celebrationMeasureMs);
    window.addEventListener("resize", measure);
    return () => {
      window.clearInterval(every);
      window.removeEventListener("resize", measure);
    };
  }, []);
  useEffect(() => {
    const over = window.setTimeout(() => end.current(), celebrationMaxMs);
    return () => window.clearTimeout(over);
  }, []);
  return createPortal(
    <div
      aria-hidden="true"
      data-suit-celebration={props.cue}
      // Over every layer, menus and sheets included; the clip keeps protected parts clear.
      className="pointer-events-none fixed inset-0 z-[2147483000]"
      style={{ clipPath: clip }}
    >
      <SceneBackdrop
        sceneUrl={props.sceneUrl}
        scheme={props.scheme}
        // Never mounted under Reduce motion (`SuitScenesProvider`).
        reduceMotion={false}
        signals={quiet}
        frames={props.frames}
        fill="above"
        region="celebration"
        wake={props.cue}
        onFinished={() => end.current()}
        onStopped={(why) => {
          props.onStopped(why);
          end.current();
        }}
      />
    </div>,
    document.body,
  );
}
