import {
  ArrowDownIcon,
  ArrowUpIcon,
  BotsIcon,
  CheckCircleIcon,
  ClockIcon,
  CoatHangerIcon,
  PlugIcon,
  PuzzlePieceIcon,
  SealCheckIcon,
  SquaresLinkedIcon,
  WarningCircleIcon,
} from "@ace/icons";
import type { CSSProperties, ReactNode } from "react";
import { part } from "@/lib/suit-part.ts";

/*
 * The small marks every Marketplace page shares: a type's glyph, a publisher's avatar and verified
 * seal, the byline, a version's state and a trending move. Drawn with ace's own icons.
 */

/** A type's mark, drawn large on a stage that has no picture of its own. */
export function TypeMark(props: { type: string; className?: string }) {
  const look = {
    "aria-hidden": true,
    size: 48,
    weight: "light",
    className: props.className ?? "mk-mark",
  } as const;
  if (props.type === "suit") return <CoatHangerIcon {...look} />;
  if (props.type === "spade-bot") return <BotsIcon {...look} />;
  if (props.type === "spade-plugin" || props.type === "ace-plugin") return <PlugIcon {...look} />;
  if (props.type === "app") return <SquaresLinkedIcon {...look} />;
  return <PuzzlePieceIcon {...look} />;
}

/** Someone's initials, from a display name or a handle. */
export function initials(name: string): string {
  const words = name
    .replace(/&/g, "")
    .split(/[\s.-]+/)
    .filter(Boolean);
  return words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

/** A stable tone for a name, from ace's status hues' neighbours, so avatars tell people apart. */
const tones = [
  "#E39B76",
  "#5FC79B",
  "#C9A15E",
  "#62B6DA",
  "#AEB4C2",
  "#B39AEC",
  "#93CE66",
  "#E08AB0",
  "#9AA6F5",
];
export function toneOf(name: string): string {
  let sum = 0;
  for (const char of name) sum = (sum * 31 + char.charCodeAt(0)) >>> 0;
  return tones[sum % tones.length] ?? "#AEB4C2";
}

/** A publisher or person: their picture when they have one, else initials in their tone. */
export function Avatar(props: {
  name: string;
  size: number;
  ace?: boolean | undefined;
  picture?: string | undefined;
}) {
  const style = {
    "--size": `${props.size}px`,
    "--tone": toneOf(props.name),
    ...(props.picture ? { backgroundImage: `url(${JSON.stringify(props.picture)})` } : {}),
  } as CSSProperties;
  return (
    <span
      aria-hidden
      {...part("avatar")}
      data-ace={props.ace ? "" : undefined}
      className="mk-avatar"
      style={style}
    >
      {props.picture ? null : props.ace ? "ace" : initials(props.name)}
    </span>
  );
}

/** ace's verified seal beside a publisher's name. */
export function Verified(props: { className?: string }) {
  return (
    <span role="img" aria-label="Verified by ace" title="Verified by ace" className="inline-flex">
      <SealCheckIcon
        aria-hidden
        weight="fill"
        size={14}
        className={props.className ?? "mk-verified"}
      />
    </span>
  );
}

/** Who published an entry: their avatar, name and seal; a button to their page when it opens. */
export function Byline(props: {
  name: string;
  ace?: boolean | undefined;
  verified?: boolean | undefined;
  onOpen?: (() => void) | undefined;
}) {
  const inner = (
    <>
      <Avatar name={props.name} size={18} ace={props.ace} />
      <span className="mk-by-name">{props.name}</span>
      {props.verified && <Verified />}
    </>
  );
  // "By ace" is the official mark: only for ace's own publisher by the signed list, never a name.
  const label = props.ace ? "By ace" : `Published by ${props.name}`;
  return props.onOpen ? (
    <button type="button" className="mk-by" aria-label={label} onClick={props.onOpen}>
      {inner}
    </button>
  ) : (
    <span className="mk-by" aria-label={label}>
      {inner}
    </span>
  );
}

const statusGlyph = {
  done: CheckCircleIcon,
  waiting: ClockIcon,
  failed: WarningCircleIcon,
} as const;

/** A state in words with its glyph: passed, waiting, failed; quiet ones are words alone. */
export function Status(props: {
  tone: "done" | "waiting" | "failed" | "needs" | "quiet";
  children: ReactNode;
}) {
  const Glyph =
    props.tone in statusGlyph ? statusGlyph[props.tone as keyof typeof statusGlyph] : undefined;
  return (
    <span className="mk-status" data-tone={props.tone}>
      {Glyph && <Glyph aria-hidden weight="fill" size={14} />}
      {props.children}
    </span>
  );
}

/** How a trending entry moved against last week. */
export type TrendMove = { kind: "new" } | { kind: "up" | "down"; by: number } | { kind: "same" };

export function Move(props: { move: TrendMove }) {
  const { move } = props;
  if (move.kind === "new")
    return (
      <span className="mk-move" data-new="">
        New
      </span>
    );
  if (move.kind === "same")
    return (
      <span className="mk-move" aria-label="No change">
        –
      </span>
    );
  const Glyph = move.kind === "up" ? ArrowUpIcon : ArrowDownIcon;
  return (
    <span className="mk-move" aria-label={`${move.kind === "up" ? "Up" : "Down"} ${move.by}`}>
      <Glyph aria-hidden weight="bold" size={10} />
      {move.by}
    </span>
  );
}
