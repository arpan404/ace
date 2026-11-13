import type { BotFaceState } from "@ace/ui-core/bot-face";
import type { SpadeAvatar } from "@ace/ui-core/spade-chat";
import { useEffect, useState } from "react";
import { BotFace } from "@/components/bot-face.tsx";
import { SpadeMark } from "@/components/spade-mark.tsx";
import { cn } from "@/lib/cn.ts";
import { holdSpadePicture } from "./spade-images.ts";
import { useSpadeClient } from "./spade-machine.tsx";

const moving = (state: BotFaceState | undefined) => state === "working" || state === "thinking";

/**
 * A bot's face (ADR 0127): the Spade mark for Spade itself, a character face, or the person's
 * uploaded picture. Its state is its status: a character face poses and moves for it, Spade's
 * eyes move while it works, and a picture carries a small Spade mark on its corner while its bot
 * works. Decorative: the row or bubble beside it names the bot.
 */
export function SpadeFace(props: {
  avatar: SpadeAvatar;
  /** Its side in px. */
  size: number;
  state?: BotFaceState | undefined;
  /** The ring the picture's corner badge cuts out of it, matching what it sits on. */
  ring?: string | undefined;
  className?: string | undefined;
}) {
  const { avatar, size } = props;
  const box = { width: size, height: size };
  if (avatar.kind === "spade")
    return (
      <span
        aria-hidden
        className={cn("grid shrink-0 text-foreground", props.className)}
        style={box}
      >
        <SpadeMark size={size} moving={moving(props.state)} />
      </span>
    );
  if (avatar.kind === "character")
    return (
      <span aria-hidden className={cn("grid shrink-0", props.className)} style={box}>
        <BotFace face={avatar.face} size={size} state={props.state} />
      </span>
    );
  const badge = Math.max(14, Math.round(size / 2));
  return (
    <span
      aria-hidden
      data-working={moving(props.state) || undefined}
      className={cn("relative grid shrink-0 place-items-center rounded-full", props.className)}
      style={box}
    >
      <Picture hash={avatar.sha256} />
      {moving(props.state) && (
        <span
          className={cn(
            "absolute -right-1 -bottom-1 grid rounded-full text-foreground",
            props.ring ?? "bg-background shadow-[0_0_0_2px_var(--background)]",
          )}
        >
          <SpadeMark size={badge} moving />
        </span>
      )}
    </span>
  );
}

/** An uploaded face, read once from Spade and held while shown. */
function Picture(props: { hash: string }) {
  const client = useSpadeClient();
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const held = holdSpadePicture(client, props.hash);
    let live = true;
    held.url.then(
      (next) => live && setUrl(next),
      () => {},
    );
    return () => {
      live = false;
      held.release();
    };
  }, [client, props.hash]);
  return url ? (
    <img alt="" src={url} className="size-full rounded-full object-cover" />
  ) : (
    <span className="size-full rounded-full bg-fill-strong" />
  );
}
