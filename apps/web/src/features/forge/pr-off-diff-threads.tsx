import type { ForgePrStatus } from "@ace/protocol";
import { Disclosure } from "@/components/ui/disclosure.tsx";
import { toolbarEdge } from "@/components/ui/rules.ts";
import { cn } from "@/lib/cn.ts";
import { PrThread } from "./pr-thread.tsx";

type ReviewThread = ForgePrStatus["reviewThreads"][number];

/**
 * Open review conversations the diff can't place beside a line (outdated, or on lines it
 * doesn't draw), folded into one strip above the files. Each is the whole conversation, with
 * its reply field and Resolve, under its file and line.
 */
export function PrOffDiffThreads(props: { threads: readonly ReviewThread[] }) {
  if (!props.threads.length) return null;
  return (
    <Disclosure
      aria-label="Conversations not on the current diff"
      className={cn("shrink-0 px-3 py-1.5", toolbarEdge)}
      summaryClassName="text-xs"
      summary={
        <>
          Conversations not on the current diff
          <span className="text-subtle-foreground tabular-nums">{props.threads.length}</span>
        </>
      }
    >
      <ul className="max-h-[40vh] divide-y divide-border-soft overflow-y-auto">
        {props.threads.map((thread) => (
          <li key={thread.id} className="py-3 pr-1">
            <PrThread thread={thread} place />
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}
