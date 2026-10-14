import type { ReactNode } from "react";
import type { Tone } from "@ace/ui-core";
import { cn } from "@/lib/cn.ts";
import { glyphTones, type GlyphState } from "./status-glyph-state.ts";

/*
 * The Aperture status glyphs: one 16-unit grid (centre 8,8), a 1.5 stroke ring of radius 5.25,
 * drawn at 12 to 18px in the tone's colour. Live states move; the rest hold still.
 *
 * Motion costs the compositor, never the main thread. Each moving part is its own tiny HTML box
 * (`.aperture-part`) whose `transform` and `opacity` a shared CSS keyframe animates
 * (styles/motion.css, "Live activity"): an SVG child's transform would repaint every frame, a
 * box's is composited. Nothing animates unless the glyph is `[data-live]`, so a still glyph, a
 * row the list hasn't mounted and a hidden window cost nothing.
 *
 *   working     the ring's two halves swing apart and back, so its opening rocks east to west
 *   background  an open ring with a dot drifting out through the opening
 *   subagents   three arcs that ratchet a third of a turn at a time
 */

const ring = 5.25;
const sizes = {
  12: "size-3",
  13: "size-3.25",
  14: "size-3.5",
  16: "size-4",
  18: "size-4.5",
} as const;

/** The ring's two halves, each a third of the ring centred on 12 and 6 o'clock. */
const topHalf = "M3.45 5.38A5.25 5.25 0 0 1 12.55 5.38";
const bottomHalf = "M12.55 10.62A5.25 5.25 0 0 1 3.45 10.62";
/** Open to the east (50° to 130°): the ring the background dot leaves through. */
const openEast = "M12.02 11.37A5.25 5.25 0 1 1 12.02 4.63";
/** Three 80° arcs, 120° apart. */
const thirds = [
  "M9.8 3.07A5.25 5.25 0 0 1 13.17 8.91",
  "M11.37 12.02A5.25 5.25 0 0 1 4.63 12.02",
  "M2.83 8.91A5.25 5.25 0 0 1 6.2 3.07",
];
/** Open at the top (320° to 40°): waiting its turn. */
const openTop = "M11.37 3.98A5.25 5.25 0 1 1 4.63 3.98";
/** A solid disc with an exclamation mark cut out of it. */
const needsYou =
  "M8 2a6 6 0 1 1 0 12a6 6 0 1 1 0-12Z M7.2 4.6h1.6v4.7H7.2Z M8 10.35a.95.95 0 1 1 0 1.9a.95.95 0 1 1 0-1.9Z";

function Svg(props: { children: ReactNode; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cn("absolute inset-0 size-full overflow-visible", props.className)}
    >
      {props.children}
    </svg>
  );
}

/** One moving part: an HTML box the size of the glyph, so its transform is composited. */
function Part(props: {
  motion: "swing" | "drift" | "ratchet";
  counter?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className="aperture-part"
      data-motion={props.motion}
      {...(props.counter ? { "data-counter": "" } : {})}
    >
      <Svg>{props.children}</Svg>
    </span>
  );
}

const Ring = () => <circle cx="8" cy="8" r={ring} />;

function Drawing(props: { state: GlyphState }) {
  switch (props.state) {
    case "working":
      return (
        <>
          <Part motion="swing">
            <path d={topHalf} />
          </Part>
          <Part motion="swing" counter>
            <path d={bottomHalf} />
          </Part>
        </>
      );
    case "background":
      return (
        <>
          <Svg>
            <path d={openEast} />
          </Svg>
          <Part motion="drift">
            <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
          </Part>
        </>
      );
    case "subagents":
      return (
        <Part motion="ratchet">
          {thirds.map((d) => (
            <path key={d} d={d} />
          ))}
        </Part>
      );
    case "needs-you":
      return (
        <Svg>
          <path d={needsYou} fill="currentColor" fillRule="evenodd" stroke="none" />
        </Svg>
      );
    case "done":
      return (
        <Svg>
          <Ring />
          <path d="M5.6 8.25l1.65 1.65 3.2-3.5" />
        </Svg>
      );
    case "failed":
      return (
        <Svg>
          <Ring />
          <path d="M6.15 6.15l3.7 3.7M9.85 6.15l-3.7 3.7" />
        </Svg>
      );
    case "stopped":
      return (
        <Svg>
          <Ring />
          <rect x="6" y="6" width="4" height="4" rx=".8" fill="currentColor" stroke="none" />
        </Svg>
      );
    case "queued":
      return (
        <Svg>
          <path d={openTop} />
        </Svg>
      );
    case "paused":
      return (
        <Svg>
          <Ring />
          <path d="M6.6 6v4M9.4 6v4" />
        </Svg>
      );
    case "idle":
      return (
        <Svg>
          <circle cx="8" cy="8" r="1.75" fill="currentColor" stroke="none" />
        </Svg>
      );
  }
}

const moving = new Set<GlyphState>(["working", "background", "subagents"]);

/**
 * A status glyph in its tone's colour (`data-tone`; the state's own tone unless `tone` names
 * another). `still` holds a live state in its rest pose (the work waits, or its facts are
 * stale). Decorative unless given a `label`; `children` sit centred inside the ring (a count).
 */
export function StatusGlyph(props: {
  state: GlyphState;
  size?: keyof typeof sizes;
  tone?: Tone | undefined;
  still?: boolean | undefined;
  label?: string | undefined;
  className?: string | undefined;
  children?: ReactNode;
}) {
  const live = moving.has(props.state) && !props.still;
  return (
    <span
      data-slot="status-glyph"
      data-state={props.state}
      data-tone={props.tone ?? glyphTones[props.state]}
      {...(live ? { "data-live": "" } : {})}
      {...(props.label ? { role: "img", "aria-label": props.label } : { "aria-hidden": true })}
      className={cn(
        "relative inline-grid shrink-0 place-items-center text-(--tone) [contain:strict]",
        sizes[props.size ?? 14],
        props.className,
      )}
    >
      <Drawing state={props.state} />
      {props.children}
    </span>
  );
}
