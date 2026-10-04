import { CaretRightIcon } from "@phosphor-icons/react";
import { useId, useState } from "react";
import { cn } from "@/lib/cn.ts";

/**
 * The text ace sent the model on the person's behalf, kept out of sight: instructions,
 * JSON and paging hints are for the model, not for reading (IR-8, IR-11).
 */
export function ModelFacing(props: { text: string; label?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const body = useId();
  return (
    <div className={props.className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={body}
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1 text-xs text-subtle-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        {props.label ?? "What the agent received"}
        <CaretRightIcon
          aria-hidden
          size={11}
          className={cn("transition-transform duration-(--dur-2)", open && "rotate-90")}
        />
      </button>
      {open && (
        <pre
          id={body}
          className="fx-rise-in mt-1 max-h-72 overflow-auto rounded-md bg-code px-3 py-2 text-left font-mono text-[12px] leading-[1.5] whitespace-pre-wrap text-muted-foreground"
        >
          {props.text}
        </pre>
      )}
    </div>
  );
}
