import { CaretRightIcon } from "@ace/icons";
import type { ReactNode } from "react";
import { Icon, type IconGlyph } from "@/components/icon.tsx";
import { part } from "@/lib/suit-part.ts";

/**
 * One way forward in a first-run list: its icon, its name and a few words on what it gives,
 * the whole row the button. A caret shows where the pointer or focus is.
 */
export function ChoiceRow(props: {
  icon: IconGlyph;
  label: string;
  hint?: ReactNode;
  onClick(): void;
  onPointerEnter?: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        {...part("list-row", undefined, "choice")}
        className="group -mx-2 flex min-h-12 w-[calc(100%+1rem)] min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors duration-(--motion-fast) hover:bg-hover focus-ring-inset"
        onClick={props.onClick}
        onPointerEnter={props.onPointerEnter}
      >
        <Icon icon={props.icon} size={16} className="shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{props.label}</span>
          {props.hint && (
            <span className="truncate text-sm text-muted-foreground">{props.hint}</span>
          )}
        </span>
        <Icon
          icon={CaretRightIcon}
          size={14}
          className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
        />
      </button>
    </li>
  );
}

/** A list of `ChoiceRow`s, with an optional small heading. */
export function ChoiceList(props: { label: string; heading?: string; children: ReactNode }) {
  return (
    <section aria-label={props.label} className="flex flex-col gap-1">
      {props.heading && (
        <h2 className="text-sm font-medium text-muted-foreground">{props.heading}</h2>
      )}
      <ul {...part("list", undefined, "choices")} className="flex flex-col">
        {props.children}
      </ul>
    </section>
  );
}
