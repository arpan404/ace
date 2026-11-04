import type { ReactNode } from "react";

/** One way to do what a sheet is for: its name, a sentence, and whether it's the one to pick. */
export interface Way<K extends string> {
  key: K;
  title: string;
  sub: ReactNode;
  recommended?: boolean;
}

/**
 * The ways a sheet offers, numbered in the order to try them, each a whole-row button. Rows sit
 * on hairlines; the recommended one says so after its name.
 */
export function SheetWays<K extends string>(props: {
  ways: readonly Way<K>[];
  onPick(key: K): void;
}) {
  return (
    <div role="list" className="-mx-2 flex flex-col">
      {props.ways.map((way, index) => (
        <div role="listitem" key={way.key} className="border-b border-border-soft last:border-b-0">
          <button
            type="button"
            onClick={() => props.onPick(way.key)}
            className="flex w-full items-start gap-3 rounded-lg px-2 py-3 text-left transition-colors duration-(--motion-fast) focus-ring-inset hover:bg-hover"
          >
            <span
              aria-hidden
              className="mt-px grid size-[22px] shrink-0 place-items-center rounded-full text-[11px] text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)] tabular-nums"
            >
              {index + 1}
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-ui text-foreground">
                {way.title}
                {way.recommended && (
                  <span className="ml-1.5 text-[11px] font-medium text-link">Recommended</span>
                )}
              </span>
              <span className="text-xs leading-relaxed text-muted-foreground">{way.sub}</span>
            </span>
          </button>
        </div>
      ))}
    </div>
  );
}
