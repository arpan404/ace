import {
  FolderSimpleIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  LaptopIcon,
} from "@phosphor-icons/react";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useCheckout } from "../lib/use-git.ts";
import type { ThreadRef } from "../sources/index.ts";

const item =
  "inline-flex h-6 min-w-0 items-center gap-[5px] rounded-sm px-[7px] text-subtle-foreground";
const link = `${item} shrink-0 focus-ring transition-colors duration-(--dur-1) hover:bg-accent hover:text-foreground`;
/** Below this the bar's words give way to their icons, which keep the names in their labels. */
const narrow = "@max-[22rem]/bar:sr-only";

function Separator() {
  return <span aria-hidden className="mx-1 h-3 w-px shrink-0 bg-border" />;
}

/**
 * Below the composer: where the thread runs (its own worktree or the local checkout), its branch
 * and how far it is from the remote, and its PR. The daemon fixes the checkout when the thread is
 * created, so this reports it rather than changing it. Narrow, nothing runs off the edge: the
 * branch truncates (whole in its tooltip), and the place and the PR's state drop to icons.
 */
export function ContextBar(props: { thread: ThreadRef }) {
  const checkout = useCheckout(props.thread);
  if (!checkout) return <div className="h-8" />;
  const sync = [
    checkout.ahead > 0 && `${checkout.ahead}↑`,
    checkout.behind > 0 && `${checkout.behind}↓`,
  ].filter(Boolean);
  const branch = checkout.branch ?? "detached HEAD";
  const place = checkout.mode === "worktree" ? "Worktree" : "Local";
  return (
    <div className="@container/bar flex h-8 min-w-0 items-center gap-0.5 px-2.5 pt-2 text-xs whitespace-nowrap text-subtle-foreground">
      <span className={`${item} shrink-0`} aria-label={place}>
        {checkout.mode === "worktree" ? (
          <FolderSimpleIcon aria-hidden size={14} className="shrink-0" />
        ) : (
          <LaptopIcon aria-hidden size={14} className="shrink-0" />
        )}
        <span aria-hidden className={narrow}>
          {place}
        </span>
      </span>
      <Separator />
      <Tip label={branch}>
        <span tabIndex={0} className={`${item} focus-ring`} aria-label={`Branch: ${branch}`}>
          <GitBranchIcon aria-hidden size={14} className="shrink-0" />
          <span className="min-w-0 truncate font-mono">{branch}</span>
          {sync.length > 0 && <span className="shrink-0 tabular-nums">{sync.join(" ")}</span>}
        </span>
      </Tip>
      {checkout.pr?.url && (
        <>
          <Separator />
          <Tip label={`Open #${checkout.pr.number} on the forge · ${checkout.pr.state}`}>
            <a href={checkout.pr.url} target="_blank" rel="noreferrer noopener" className={link}>
              <GitPullRequestIcon aria-hidden size={14} />#{checkout.pr.number}
              <span className={`text-subtle-foreground ${narrow}`}>· {checkout.pr.state}</span>
            </a>
          </Tip>
        </>
      )}
    </div>
  );
}
