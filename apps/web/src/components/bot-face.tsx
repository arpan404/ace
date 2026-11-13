import {
  botFaceColourVars,
  botFaceMarkup,
  faceTier,
  type BotFace as BotFaceModel,
  type BotFaceState,
} from "@ace/ui-core/bot-face";
import { observeBotFace } from "./bot-face-visibility.ts";
import { useId, useMemo, type CSSProperties, type MouseEvent } from "react";

/**
 * A bot's character face, drawn from its eight fields by ui-core's geometry at a size tier
 * (24, 32, 48, 96+). `state` poses it; working and thinking loop, the rest move once and hold,
 * and reduced motion shows each pose still (`bot-face.css`). Decorative: the row or bubble
 * beside it names the bot.
 */
export function BotFace(props: {
  face: BotFaceModel;
  /** Its side in px. */
  size: number;
  state?: BotFaceState | undefined;
  /** Where the pupils look, each axis -1 to 1; resting when absent. */
  look?: { x: number; y: number } | undefined;
  /** A blink or a hop that plays once; each new `at` plays it again. */
  cue?: { kind: "blink" | "hop"; at: number } | undefined;
  /** Its parts step on click (the editor's big face): the drawn part's name. */
  onPart?: ((part: string) => void) | undefined;
  className?: string | undefined;
}) {
  const { face, size } = props;
  // Clip ids must be unique on the page and plain: React's ids carry colons.
  const uid = `bf${useId().replaceAll(/[^a-zA-Z0-9_-]/g, "")}`;
  const markup = useMemo(() => botFaceMarkup(face, size, uid), [face, size, uid]);
  const style = useMemo(() => {
    const vars: Record<string, string> = botFaceColourVars(face);
    if (props.look) {
      vars["--lx"] = String(props.look.x);
      vars["--ly"] = String(props.look.y);
    }
    return vars as CSSProperties;
  }, [face, props.look]);
  const onClick = props.onPart
    ? (event: MouseEvent<SVGSVGElement>) => {
        const part =
          event.target instanceof Element ? event.target.closest("[data-part]") : undefined;
        const name = part?.getAttribute("data-part");
        if (name) props.onPart?.(name);
      }
    : undefined;
  return (
    <svg
      ref={observeBotFace}
      key={props.cue?.at ?? 0}
      aria-hidden
      viewBox="0 0 24 24"
      width={size}
      height={size}
      overflow="visible"
      className={props.className ? `bot-face ${props.className}` : "bot-face"}
      data-face={`${face.body} ${face.pair}`}
      data-state={props.state ?? "idle"}
      data-tier={faceTier(size)}
      data-look={props.look ? "" : undefined}
      data-cue={props.cue?.kind}
      data-editable={props.onPart ? "" : undefined}
      style={style}
      onClick={onClick}
      // Markup ui-core builds from the face's enumerated fields and numbers only, never from
      // text a person or a server wrote, so there is nothing in it to escape.
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
