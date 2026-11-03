import type { ReactNode } from "react";

/**
 * A whole screen whose subject isn't here: a thread deleted or on another machine, a project
 * removed. One 480px column, set a little above the middle: the title, one muted line, the ways
 * on side by side, and below a hairline whatever the person still has of it (a saved message).
 * No glyph and no card, as with `EmptyState`.
 */
export function MissingState(props: {
  title: string;
  description?: ReactNode;
  /** Buttons or links, the main one first. */
  actions?: ReactNode;
  /** What is kept of the missing thing, under a hairline. */
  children?: ReactNode;
}) {
  return (
    <div
      data-slot="missing"
      className="flex h-full min-h-0 flex-col items-center overflow-y-auto px-6 pt-[18vh] pb-12"
    >
      <div className="w-full max-w-[480px]">
        <h2 className="text-lg font-medium tracking-tight text-balance text-foreground">
          {props.title}
        </h2>
        {props.description && (
          <p className="mt-1.5 max-w-[52ch] text-ui leading-relaxed text-pretty text-muted-foreground">
            {props.description}
          </p>
        )}
        {props.actions && <div className="mt-5 flex flex-wrap gap-2">{props.actions}</div>}
        {props.children && <div className="mt-8 border-t border-border pt-5">{props.children}</div>}
      </div>
    </div>
  );
}
