import type { ReactNode, Ref } from "react";
import { readingColumn } from "../lib/column.ts";

const composerInset = {
  paddingLeft: "var(--transcript-gutter)",
  paddingRight: "calc(var(--transcript-gutter) + var(--summary-inset, 0px))",
};

/**
 * Where a thread's composer sits: under the transcript, on its reading column. A pinned summary
 * beside the text insets it (`--summary-inset`), so their edges still agree. The backdrop runs
 * from 2.5rem above the composer to the bottom edge and fades in over its first 2.5rem, so
 * transcript text dissolves under it with no band edge.
 */
export function ComposerDock({
  ref,
  children,
}: {
  ref?: Ref<HTMLDivElement> | undefined;
  children: ReactNode;
}) {
  return (
    <div
      ref={ref}
      style={composerInset}
      className="relative flex-none pb-4 before:pointer-events-none before:absolute before:inset-x-0 before:-top-10 before:bottom-0 before:bg-reading before:[mask-image:linear-gradient(to_bottom,transparent,black_2.5rem)]"
    >
      <div className={`relative ${readingColumn}`}>{children}</div>
    </div>
  );
}
