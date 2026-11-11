import { spadeAvatarFill, type SpadeAvatar } from "@ace/ui-core/spade-chat";
import { useEffect, useState } from "react";
import { SpadeMark } from "@/components/spade-mark.tsx";
import { cn } from "@/lib/cn.ts";
import { holdSpadePicture } from "./spade-images.ts";
import { useSpadeClient } from "./spade-machine.tsx";

/**
 * A bot's face (ADR 0127): the Spade mark for Spade itself, else the person's uploaded picture or
 * initials on its colour. While the bot works its eyes move: Spade's own, or, on another bot's
 * face, a small Spade mark on its corner. Decorative: the row or bubble beside it names the bot.
 */
export function SpadeFace(props: {
  avatar: SpadeAvatar;
  /** Its diameter in px. */
  size: number;
  working?: boolean | undefined;
  /** The ring the corner badge cuts out of the face, matching what the face sits on. */
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
        <SpadeMark size={size} moving={props.working} />
      </span>
    );
  const badge = Math.max(14, Math.round(size / 2));
  return (
    <span
      aria-hidden
      data-working={props.working || undefined}
      className={cn(
        "relative grid shrink-0 place-items-center rounded-full font-medium text-white",
        props.className,
      )}
      style={{
        ...box,
        fontSize: Math.max(10, Math.round(size * 0.38)),
        ...(avatar.kind === "generated" ? { backgroundColor: spadeAvatarFill[avatar.color] } : {}),
      }}
    >
      {avatar.kind === "image" ? <Picture hash={avatar.sha256} /> : avatar.initials}
      {props.working && (
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
