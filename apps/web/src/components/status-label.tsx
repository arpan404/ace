import type { ReactNode } from "react";
import { type Tone } from "@ace/ui-core";
import { cn } from "@/lib/cn.ts";

/**
 * A status in words: the thread rows, the header's usage limit, downloads and
 * computer use. Coloured text and a small mark, never a fill or a border, so a column of them
 * stays quiet. The colour is the tone's (`data-tone`, see index.css) as `--tone-text`, its hue
 * made AA on every surface of the theme. The mark defaults to the tone's dot; a row passes its
 * own (a spinner while working), and `children` follow the words (a working row's elapsed time).
 */
export function StatusLabel(props: {
  tone: Tone;
  label: string;
  mark?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <span
      data-tone={props.tone}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-xs font-medium whitespace-nowrap text-(--tone-text)",
        props.className,
      )}
    >
      {props.mark ?? <span aria-hidden className="size-1.5 rounded-full bg-(--tone)" />}
      {props.label}
      {props.children}
    </span>
  );
}
