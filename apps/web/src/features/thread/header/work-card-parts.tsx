import type { ComponentProps, ReactNode } from "react";
import { useWorkCardState } from "./work-card-state.tsx";
import { cn } from "@/lib/cn.ts";
import { CaretLeftIcon } from "@phosphor-icons/react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.tsx";

/*
 * The work card's few shapes: a muted section heading, a 32px row with a leading 16px icon, and
 * the hairline between sections. 13px text throughout, as in the rest of the app's menus.
 */

/** A row's leading glyph colour: muted, so the words lead. */
export const rowIcon = "shrink-0 text-muted-foreground";

const row =
  "flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-left text-ui text-foreground";

/** A row that does something: opens a tab, runs a script, opens a pull request. */
export function RowButton({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        row,
        "focus-ring-inset transition-colors duration-(--dur-1) hover:bg-accent disabled:text-muted-foreground disabled:hover:bg-transparent",
        className,
      )}
      {...props}
    />
  );
}

/** A row that only says something ("No pull request yet"). */
export function RowNote(props: { children: ReactNode; className?: string | undefined }) {
  return <p className={cn(row, "text-subtle-foreground", props.className)}>{props.children}</p>;
}

/** A section's muted heading, with its own controls (+) at the end. */
export function WorkSection(props: {
  id: string;
  title: string;
  controls?: ReactNode;
  children: ReactNode;
}) {
  const { state, update } = useWorkCardState();
  return (
    <Collapsible
      open={state.sections[props.id] ?? true}
      onOpenChange={(open) => update({ sections: { [props.id]: open } })}
      render={<section aria-labelledby={props.id} />}
    >
      <div className="flex min-w-0 items-center gap-1 pr-1">
        <h3 id={props.id} className="min-w-0 flex-1">
          <CollapsibleTrigger className="group/section focus-ring-inset flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2.5 text-left text-ui text-muted-foreground hover:bg-accent">
            <CaretLeftIcon
              aria-hidden
              size={12}
              className="shrink-0 group-data-panel-open/section:-rotate-90"
            />
            <span className="min-w-0 truncate font-medium">{props.title}</span>
          </CollapsibleTrigger>
        </h3>
        {props.controls}
      </div>
      <CollapsibleContent keepMounted>{props.children}</CollapsibleContent>
    </Collapsible>
  );
}

export function Rule() {
  return <hr aria-hidden className="mx-2.5 my-1.5 border-t border-border" />;
}

/** A cut line ends with an ellipsis. */
export function TruncatedText({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn("min-w-0 flex-1 truncate", className)} {...props} />;
}
