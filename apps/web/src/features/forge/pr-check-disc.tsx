import { CheckIcon, MinusIcon, XIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";

/** A check's (or step's) state as a disc: "failed", "done", "working", "idle" (stopped), "off". */
export type DiscTone = "failed" | "done" | "working" | "idle" | "off";

/** Maps a status tone from ui-core ("failed", "done", "working", "idle") to its disc. */
export function discTone(tone: string): DiscTone {
  return tone === "failed" || tone === "done" || tone === "working" || tone === "idle"
    ? tone
    : "off";
}

const glyphs = { failed: XIcon, done: CheckIcon, idle: MinusIcon } as const;

/**
 * A small solid disc in the state's colour with its glyph: failed carries an X, passed a tick,
 * stopped a dash. Running is an open ring in the working tone, not run a faint ring.
 */
export function CheckDisc(props: { tone: DiscTone; large?: boolean; className?: string }) {
  const size = props.large ? "size-5" : "size-4";
  if (props.tone === "working" || props.tone === "off")
    return (
      <span
        aria-hidden
        data-tone={props.tone === "working" ? "working" : undefined}
        className={cn(
          "shrink-0 rounded-full",
          size,
          props.tone === "working"
            ? "border-2 border-(--tone) border-r-transparent"
            : "border-[1.5px] border-faint-foreground",
          props.className,
        )}
      />
    );
  const Glyph = glyphs[props.tone];
  return (
    <span
      aria-hidden
      data-tone={props.tone === "idle" ? undefined : props.tone}
      className={cn(
        "grid shrink-0 place-items-center rounded-full text-background",
        size,
        props.tone === "idle" ? "bg-subtle-foreground" : "bg-(--tone)",
        props.className,
      )}
    >
      <Glyph size={props.large ? 12 : 10} weight="bold" />
    </span>
  );
}
