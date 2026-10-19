import type { ForgePrStatus } from "@ace/protocol";
import { Disclosure } from "@/components/ui/disclosure.tsx";
import { toolbarEdge } from "@/components/ui/rules.ts";
import { cn } from "@/lib/cn.ts";

type ReviewThread = ForgePrStatus["reviewThreads"][number];

/**
 * Open review conversations the diff can't place beside a line, folded into one strip above
 * the files. Each row names its file and line and opens on its first comment.
 */
export function PrOffDiffThreads(props: {
  threads: readonly ReviewThread[];
  onFile(path: string): void;
}) {
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
      <ul className="max-h-48 space-y-1 overflow-y-auto pt-1.5 pb-0.5">
        {props.threads.map((thread) => {
          const first = thread.comments[0];
          return (
            <li key={thread.id} className="min-w-0 text-xs">
              <button
                type="button"
                onClick={() => props.onFile(thread.file)}
                className="flex w-full min-w-0 items-center gap-2 rounded-sm px-1 py-0.5 text-left text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-ring-inset"
              >
                <span dir="rtl" className="max-w-[50%] min-w-0 shrink-0 truncate text-left">
                  <bdi dir="ltr" className="font-mono">
                    {thread.file}
                    {thread.line !== null && `:${thread.line}`}
                  </bdi>
                </span>
                {thread.outdated && (
                  <span className="shrink-0 text-subtle-foreground">Outdated</span>
                )}
                {first && (
                  <span className="min-w-0 truncate">
                    <span className="font-medium text-foreground">{first.author}</span>{" "}
                    {first.body.split("\n")[0]}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </Disclosure>
  );
}
