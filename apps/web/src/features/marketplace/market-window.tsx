import type { SuitDetail } from "@ace/protocol/suits";
import {
  ArrowUpIcon,
  ChatsCircleIcon,
  ClockIcon,
  FolderSimpleIcon,
  GitBranchIcon,
  StorefrontIcon,
} from "@ace/icons";
import type { Scheme } from "@ace/themes";
import { useCallback, type CSSProperties, type ReactNode } from "react";
import { SpadeMark } from "@/components/spade-mark.tsx";
import { suitDeclarations, suitSchemeFor } from "@/theme/suits/suit-css.ts";

/*
 * The ace window, drawn at 1120×700 in any look and scaled to its box, so a Suit's thumbnail is
 * the real layout in its palette, not a sketch. A look's tokens are scoped to the element the way
 * `<html>` scopes them for the app (`data-theme` + `data-scheme` + the Suit's declarations).
 */

/** How an element is scoped to a Suit in a scheme: attributes and inline tokens. */
export function lookScope(suit: SuitDetail, wanted: Scheme) {
  const scheme = suitSchemeFor(suit.manifest, wanted);
  return {
    "data-theme": suit.manifest.base,
    "data-scheme": scheme,
    style: suitDeclarations(suit, scheme) as CSSProperties,
  };
}

/** The Suit's still for `scheme`, as a served URL, when it has one this page can load. */
export function suitPicture(suit: SuitDetail, scheme: Scheme): string | undefined {
  const path = suit.manifest.thumbnail?.[suitSchemeFor(suit.manifest, scheme)];
  return path ? suit.assets[path] : undefined;
}

/**
 * Sets `--k` on the box: the scale that fits a 1120×700 window to its width (`cover` also fills
 * its height). Measured as the box resizes; without ResizeObserver the CSS default holds.
 */
export function useFitScale(cover: boolean) {
  return useCallback(
    (box: HTMLElement | null) => {
      if (!box || typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver(([entry]) => {
        if (!entry) return;
        const { width, height } = entry.contentRect;
        const k = cover ? Math.max(width / 1120, height / 700) : width / 1120;
        box.style.setProperty("--k", k.toFixed(4));
      });
      observer.observe(box);
      return () => observer.disconnect();
    },
    [cover],
  );
}

const rows: readonly { project: string; title: string; dot?: string; on?: boolean }[] = [
  { project: "ace-next", title: "Approve the migration plan", dot: "var(--status-needs-you)" },
  { project: "ace-next", title: "Fix the reconnect race", dot: "var(--status-working)", on: true },
  { project: "ace-next", title: "Split the review page" },
  { project: "spade", title: "Morning digest at 8:00" },
  { project: "market", title: "Withdrawals scoped to a version" },
  { project: "ace-next", title: "Bump Bun to 1.4" },
];

/** One ace window: its bar, rail, thread list, one exchange and the composer. */
function Window(props: { picture?: string | undefined }) {
  return (
    <div
      className="mk-win"
      data-picture={props.picture ? "" : undefined}
      style={
        props.picture
          ? ({ "--w-picture": `url(${JSON.stringify(props.picture)})` } as CSSProperties)
          : undefined
      }
    >
      <div className="mk-win-bar">
        <div className="mk-win-lights">
          <i />
          <i />
          <i />
        </div>
        <div className="mk-win-title">
          <span>ace-next /</span> Fix the reconnect race
        </div>
      </div>
      <div className="mk-win-rail">
        <i>
          <FolderSimpleIcon size={18} />
        </i>
        <i>
          <ChatsCircleIcon size={18} />
        </i>
        <i>
          <SpadeMark size={18} />
        </i>
        <hr />
        <i>
          <GitBranchIcon size={18} />
        </i>
        <i>
          <ClockIcon size={18} />
        </i>
        <i data-on="">
          <StorefrontIcon size={18} />
        </i>
      </div>
      <div className="mk-win-canvas">
        <div className="mk-win-panel">
          <h4>Projects</h4>
          <div className="mk-win-tabs">
            <span data-on="">Inbox</span>
            <span>Snoozed</span>
            <span>Settled</span>
          </div>
          {rows.map((row) => (
            <div key={row.title} className="mk-win-row" data-on={row.on ? "" : undefined}>
              <small>
                {row.project}
                {row.dot && <i style={{ background: row.dot }} />}
              </small>
              <b>{row.title}</b>
            </div>
          ))}
        </div>
        <div className="mk-win-main">
          <div className="mk-win-transcript">
            <div className="mk-win-bubble">
              The relay drops the first frame after a reconnect. Find out why.
            </div>
            <div className="mk-win-worked">Worked for 3m 12s</div>
            <div className="mk-win-answer">
              The socket resumes before the replay cursor is set, so the first frame lands on a
              stale cursor and is dropped. I moved the cursor update ahead of the resume in{" "}
              <code>relay/resume.ts</code> and added a test that reconnects mid-stream.
            </div>
          </div>
          <div className="mk-win-composer">
            <span>Ask for follow-up changes</span>
            <i className="mk-win-send">
              <ArrowUpIcon size={16} weight="bold" />
            </i>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The window in a Suit's look (or the app's own when `suit` is absent), at its design size,
 * scaled into its parent: `cover` fills a stage, otherwise it fits the width (a shot).
 */
export function AceWindow(props: { suit?: SuitDetail | undefined; scheme: Scheme }) {
  const scope = props.suit ? lookScope(props.suit, props.scheme) : undefined;
  const picture = props.suit ? suitPicture(props.suit, props.scheme) : undefined;
  return (
    <div aria-hidden className="mk-win-fit" {...scope}>
      <Window picture={picture} />
    </div>
  );
}

/** A window scaled to fit a box's width, for Try it's bar and the hero's slides. */
export function Shot(props: {
  suit?: SuitDetail | undefined;
  scheme: Scheme;
  children?: ReactNode;
}) {
  const fit = useFitScale(false);
  return (
    <div ref={fit} className="mk-shot">
      <AceWindow suit={props.suit} scheme={props.scheme} />
      {props.children}
    </div>
  );
}
