import type { ReactNode } from "react";

/**
 * A whole screen whose subject isn't here: a thread deleted or on another machine, a project
 * removed. Centred in the pane like `EmptyState`: the title, one muted line, the ways on side by
 * side, and under them whatever the person still has of it (a saved message). No glyph, no card.
 */
export function MissingState(props: {
  title: string;
  description?: ReactNode;
  /** Buttons or links, the main one first. */
  actions?: ReactNode;
  /** What is kept of the missing thing, under the actions. */
  children?: ReactNode;
}) {
  return (
    <div
      data-slot="missing"
      className="flex h-full min-h-0 flex-col items-center justify-center overflow-y-auto px-6 py-10 text-center"
    >
      <h2 className="text-base font-medium text-balance text-foreground">{props.title}</h2>
      {props.description && (
        <p className="mt-1 max-w-[44ch] text-ui leading-normal text-pretty text-muted-foreground">
          {props.description}
        </p>
      )}
      {props.actions && (
        <div className="mt-4 flex flex-wrap justify-center gap-2">{props.actions}</div>
      )}
      {props.children && <div className="mt-8 w-full max-w-[44ch]">{props.children}</div>}
    </div>
  );
}
