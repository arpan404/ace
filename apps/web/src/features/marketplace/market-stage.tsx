import { botFaceColourVars, type BotFace as BotFaceModel } from "@ace/ui-core/bot-face";
import type { SuitDetail } from "@ace/protocol/suits";
import type { CSSProperties } from "react";
import { BotFace } from "@/components/bot-face.tsx";
import { useTheme } from "@/theme/theme-provider.tsx";
import { part } from "@/lib/suit-part.ts";
import type { EntryKey } from "./market-api.ts";
import { useBotLook, useSuitLook } from "./market-looks.ts";
import { TypeMark } from "./market-marks.tsx";
import { useMarketPicture } from "./market-publishing.ts";
import { AceWindow, useFitScale } from "./market-window.tsx";

/*
 * Every entry has a stage: a Suit is the ace window in its palette, a bot its face over a floor
 * in its colour, a skill or plugin its name set in mono, an app its mark. A listing with pictures
 * of its own shows its first; without one, or before a look is known, its type's mark.
 */

export type StageSize = "large" | "card" | "small";

const faceSizes: Readonly<Record<StageSize, number>> = { large: 220, card: 96, small: 40 };

/** The stage for an entry the person sees in a card, row or hero. */
export function Stage(props: {
  /** `previews`: the listing's pictures (ADR 0174 §5); the first is drawn when it loads. */
  entry: EntryKey & { previews?: readonly string[] | undefined };
  size: StageSize;
  className?: string;
  style?: CSSProperties;
}) {
  const picture = useMarketPicture("preview", props.entry.previews?.[0]);
  if (picture)
    return (
      <div
        {...part("market-stage", undefined, "picture")}
        className={`mk-stage ${props.className ?? ""}`}
        data-type="picture"
        style={props.style}
      >
        <img src={picture} alt="" className="mk-stage-picture" draggable={false} />
      </div>
    );
  if (props.entry.type === "suit") return <SuitStage {...props} />;
  if (props.entry.type === "spade-bot") return <BotStage {...props} />;
  return <ToolStage {...props} />;
}

function SuitStage(props: { entry: EntryKey; className?: string; style?: CSSProperties }) {
  const suit = useSuitLook(props.entry);
  return <SuitPicture suit={suit} className={props.className} style={props.style} />;
}

/** A Suit's window filling a stage, in the scheme on screen (or `scheme`). */
export function SuitPicture(props: {
  suit: SuitDetail | undefined;
  scheme?: "light" | "dark" | undefined;
  className?: string | undefined;
  style?: CSSProperties | undefined;
}) {
  const shown = useTheme().resolved.scheme;
  const fit = useFitScale(true);
  return (
    <div
      ref={fit}
      {...part("market-stage", undefined, "suit")}
      className={`mk-stage ${props.className ?? ""}`}
      data-type="suit"
      style={props.style}
    >
      {props.suit ? (
        <AceWindow suit={props.suit} scheme={props.scheme ?? shown} />
      ) : (
        <TypeMark type="suit" />
      )}
    </div>
  );
}

function BotStage(props: {
  entry: EntryKey;
  size: StageSize;
  className?: string;
  style?: CSSProperties;
}) {
  const face = useBotLook(props.entry);
  return (
    <BotPicture
      face={face}
      size={faceSizes[props.size]}
      className={props.className}
      style={props.style}
    />
  );
}

/** A bot's face on its tinted stage, with the soft floor under it. */
export function BotPicture(props: {
  face: BotFaceModel | undefined;
  size: number;
  className?: string | undefined;
  style?: CSSProperties | undefined;
}) {
  const tint = props.face ? (botFaceColourVars(props.face) as CSSProperties) : undefined;
  return (
    <div
      {...part("market-stage", undefined, "bot")}
      className={`mk-stage ${props.className ?? ""}`}
      data-type="bot"
      style={{ ...tint, ...props.style }}
    >
      {props.face ? (
        <>
          <BotFace face={props.face} size={props.size} />
          <span className="mk-floor" />
        </>
      ) : (
        <TypeMark type="spade-bot" />
      )}
    </div>
  );
}

function ToolStage(props: {
  entry: EntryKey;
  size: StageSize;
  className?: string;
  style?: CSSProperties;
}) {
  const plugin = props.entry.type !== "spade-skill";
  return (
    <div
      {...part("market-stage", undefined, "tool")}
      className={`mk-stage ${props.className ?? ""}`}
      data-type="tool"
      style={props.style}
    >
      <span className="mk-tool-slug" style={props.size === "large" ? { fontSize: 18 } : undefined}>
        {plugin && <span className="mk-prompt">$ </span>}
        {/* A zero-width space after each hyphen lets a long name break there. */}
        {props.entry.name.replaceAll("-", "-\u200b")}
      </span>
    </div>
  );
}

/** An app's mark: its initial on its tile. */
export function AppMark(props: { name: string; size?: number }) {
  return (
    <span
      aria-hidden
      className="mk-app-mark"
      style={{ "--size": `${props.size ?? 40}px` } as CSSProperties}
    >
      {props.name.charAt(0).toUpperCase()}
    </span>
  );
}
