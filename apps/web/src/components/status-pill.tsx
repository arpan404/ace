import { cn } from "@/lib/cn.ts";
import { type Tone } from "@ace/ui-core";

/**
 * Tinted chip for a status: the thread status chip, the agent tree and Activity. Its hue is
 * the tone's (`data-tone`, see index.css): a wash behind, the hue mixed toward the text colour so
 * the words read at AA on every theme.
 */
export function StatusPill(props: { tone: Tone; label: string; className?: string }) {
  return (
    <span
      data-slot="status-pill"
      data-tone={props.tone}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-(--tone)/13 px-[9px] text-[12px] font-medium whitespace-nowrap text-[color-mix(in_oklab,var(--tone)_80%,var(--foreground))]",
        props.className,
      )}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {props.label}
    </span>
  );
}
