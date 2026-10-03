import {
  FolderSimpleIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  LaptopIcon,
} from "@phosphor-icons/react";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useCheckout } from "../lib/use-git.ts";
import type { ThreadRef } from "../sources/index.ts";

const item = "inline-flex h-6 items-center gap-[5px] rounded-sm px-[7px] text-subtle-foreground";
const link = `${item} outline-none transition-colors duration-(--dur-1) hover:bg-accent hover:text-foreground`;

function Separator() {
  return <span aria-hidden className="mx-1 h-3 w-px bg-border" />;
}

/**
 * Below the composer: where the thread runs (its own worktree or the local checkout), its branch
 * and how far it is from the remote, and its PR. The daemon fixes the checkout when the thread is
 * created, so this reports it rather than changing it.
 */
export function ContextBar(props: { thread: ThreadRef }) {
  const checkout = useCheckout(props.thread);
  if (!checkout) return <div className="h-8" />;
  const sync = [
    checkout.ahead > 0 && `${checkout.ahead}↑`,
    checkout.behind > 0 && `${checkout.behind}↓`,
  ].filter(Boolean);
  return (
    // Narrow, the bar scrolls sideways instead of running off the edge, and fades at whichever
    // edge has more to scroll to.
    <div className="flex h-8 scroll-fade-x items-center gap-0.5 overflow-x-auto px-2.5 pt-2 text-[12px] whitespace-nowrap text-subtle-foreground [--scroll-fade-size:2rem] [scrollbar-width:none] *:shrink-0">
      <span className={item}>
        {checkout.mode === "worktree" ? (
          <FolderSimpleIcon aria-hidden size={14} />
        ) : (
          <LaptopIcon aria-hidden size={14} />
        )}
        {checkout.mode === "worktree" ? "Worktree" : "Local"}
      </span>
      <Separator />
      <span className={item} aria-label={`Branch: ${checkout.branch ?? "detached HEAD"}`}>
        <GitBranchIcon aria-hidden size={14} />
        <span className="font-mono text-[11.5px]">{checkout.branch ?? "detached HEAD"}</span>
        {sync.length > 0 && <span className="tabular-nums">{sync.join(" ")}</span>}
      </span>
      {checkout.pr?.url && (
        <>
          <Separator />
          <Tip label="Open on the forge">
            <a href={checkout.pr.url} target="_blank" rel="noreferrer noopener" className={link}>
              <GitPullRequestIcon aria-hidden size={14} />#{checkout.pr.number}
              <span className="text-subtle-foreground">· {checkout.pr.state}</span>
            </a>
          </Tip>
        </>
      )}
    </div>
  );
}
