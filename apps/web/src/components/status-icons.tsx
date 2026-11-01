import { useId } from "react";
import type { RowStatusIconKind } from "@ace/ui-core";

/*
 * The solid thread-row status icons (approved design
 * `/tmp/sidebar-mocks/status-icons-approved.html`, `solid` variant, viewBox `0 0 16 16`).
 * One component holds the whole set; the state-to-icon mapping lives in ui-core
 * (`rowStatusLook`), so iOS reuses it. Every shape and symbol `d` below copies the mock
 * exactly; only the cut-out colour changes.
 *
 * The mock strokes each cut-out symbol with the surface colour (`var(--panel)`). A row sits on
 * several surfaces (the panel, hover, the open row's fill, the hover card), so the cut-out is
 * knocked out of its solid shape with a mask instead: the same geometry in white, the same
 * symbol in black, the shape filled in `currentColor` through it. The result reads on any
 * background with no per-surface token. Nothing here animates, and nothing carries `data-live`
 * or an `fx-*` class.
 */

const cut = {
  fill: "none",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const pins = {
  fill: "none",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function Drawing(props: { kind: RowStatusIconKind; id: string }) {
  const { kind, id } = props;
  const mask = `url(#${id})`;
  switch (kind) {
    case "approve":
      return (
        <>
          <defs>
            <mask id={id}>
              <path d="M8 1 2 3.3v4.5c0 3.5 2.5 6.1 6 7.2 3.5-1.1 6-3.7 6-7.2V3.3z" fill="white" />
              <path d="M5.6 8.1 7.3 9.7l3.1-3.2" stroke="black" {...cut} />
            </mask>
          </defs>
          <path
            d="M8 1 2 3.3v4.5c0 3.5 2.5 6.1 6 7.2 3.5-1.1 6-3.7 6-7.2V3.3z"
            fill="currentColor"
            mask={mask}
          />
        </>
      );
    case "question":
      return (
        <>
          <defs>
            <mask id={id}>
              <path
                d="M8 1.75c3.3 0 6 2.2 6 5.25S11.3 12.25 8 12.25c-.8 0-1.6-.1-2.3-.4L2.5 13.2l.9-2.6A4.9 4.9 0 0 1 2 7c0-3.05 2.7-5.25 6-5.25z"
                fill="white"
              />
              <path
                d="M6.6 5.7a1.45 1.45 0 1 1 2.1 1.3c-.5.3-.7.6-.7 1.1"
                stroke="black"
                {...cut}
              />
              <circle cx="8" cy="9.8" r=".7" fill="black" />
            </mask>
          </defs>
          <path
            d="M8 1.75c3.3 0 6 2.2 6 5.25S11.3 12.25 8 12.25c-.8 0-1.6-.1-2.3-.4L2.5 13.2l.9-2.6A4.9 4.9 0 0 1 2 7c0-3.05 2.7-5.25 6-5.25z"
            fill="currentColor"
            mask={mask}
          />
        </>
      );
    case "model":
      return (
        <>
          <defs>
            <mask id={id}>
              <rect x="3" y="3" width="10" height="10" rx="2.4" fill="white" />
              <path d="M8 6v2.2M8 10.1v.1" stroke="black" {...cut} />
            </mask>
          </defs>
          <rect x="3" y="3" width="10" height="10" rx="2.4" fill="currentColor" mask={mask} />
          <path
            d="M6 1.25v1.5M10 1.25v1.5M6 13.25v1.5M10 13.25v1.5M1.25 6h1.5M1.25 10h1.5M13.25 6h1.5M13.25 10h1.5"
            stroke="currentColor"
            {...pins}
          />
        </>
      );
    case "failed":
      return (
        <>
          <defs>
            <mask id={id}>
              <path
                d="M6.9 2.1a1.25 1.25 0 0 1 2.2 0l5.5 10.1a1.25 1.25 0 0 1-1.1 1.85H2.5a1.25 1.25 0 0 1-1.1-1.85z"
                fill="white"
              />
              <path d="M8 6v3.2" stroke="black" {...cut} />
              <circle cx="8" cy="11.3" r=".75" fill="black" />
            </mask>
          </defs>
          <path
            d="M6.9 2.1a1.25 1.25 0 0 1 2.2 0l5.5 10.1a1.25 1.25 0 0 1-1.1 1.85H2.5a1.25 1.25 0 0 1-1.1-1.85z"
            fill="currentColor"
            mask={mask}
          />
        </>
      );
    case "working":
      return (
        <>
          <circle fill="currentColor" cx="8" cy="8" r="6.5" opacity=".28" />
          <path fill="currentColor" d="M8 8V1.5A6.5 6.5 0 0 1 14.5 8z" />
        </>
      );
    case "waiting":
      return (
        <path
          fill="currentColor"
          d="M4 1.5h8a.5.5 0 0 1 .5.5c0 2.7-2.6 3.4-3.6 6 1 2.6 3.6 3.3 3.6 6a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5c0-2.7 2.6-3.4 3.6-6-1-2.6-3.6-3.3-3.6-6a.5.5 0 0 1 .5-.5z"
        />
      );
    case "background":
      return (
        <>
          <defs>
            <mask id={id}>
              <rect x="1.25" y="2.25" width="13.5" height="11.5" rx="2.4" fill="white" />
              <path d="m4.6 6.3 2.1 1.7-2.1 1.7M8.4 10.1h2.9" stroke="black" {...cut} />
            </mask>
          </defs>
          <rect
            x="1.25"
            y="2.25"
            width="13.5"
            height="11.5"
            rx="2.4"
            fill="currentColor"
            mask={mask}
          />
        </>
      );
    case "done":
      return (
        <>
          <defs>
            <mask id={id}>
              <circle cx="8" cy="8" r="6.5" fill="white" />
              <path d="m5.5 8.1 1.8 1.8 3.3-3.6" stroke="black" {...cut} />
            </mask>
          </defs>
          <circle cx="8" cy="8" r="6.5" fill="currentColor" mask={mask} />
        </>
      );
    case "seen":
      return (
        <path
          d="m4 8.3 2.6 2.6L12 5.4"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
  }
}

/**
 * One solid status icon in the current colour. Decorative: the row names its state in words for
 * assistive tech, so the icon itself is hidden.
 */
export function StatusIcon(props: { kind: RowStatusIconKind; size?: number | undefined }) {
  const raw = useId().replace(/[^a-zA-Z0-9]/g, "");
  const id = `status-${raw}`;
  const size = props.size ?? 14;
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      data-icon={props.kind}
      className="shrink-0"
    >
      <Drawing kind={props.kind} id={id} />
    </svg>
  );
}
