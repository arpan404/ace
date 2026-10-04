import { useThreadMeta } from "@ace/client-react";
import { ListBulletsIcon, PushPinSimpleSlashIcon } from "@phosphor-icons/react";
import { Suspense, useLayoutEffect, useState, type RefObject } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { SkeletonText } from "@/components/ui/skeleton.tsx";
import { useHotkey } from "@/lib/hotkeys.ts";
import { keymap } from "@/lib/keymap.ts";
import { useProjectName } from "@/lib/projects.ts";
import { useScopeWorkspace, useWorkspaceActions } from "@/lib/workspace/index.ts";
import { DeferredSummaryBody } from "../deferred.ts";
import type { ThreadRef } from "../sources/index.ts";
import { SummaryMenu } from "./summary-menu.tsx";

/** The pinned card's width; the transcript keeps this much (and a 16px gap) clear beside it. */
export const summaryWidth = 288;
/** The card's width and its 16px gap: what the transcript keeps clear beside a pinned card. */
export const summaryInset = summaryWidth + 16;

/** The reading column's widest (`--column`) and narrowest useful widths. */
const column = 736;
const narrowest = 480;

export type SummaryPlacement = "gutter" | "inset" | "inline";

/**
 * Where the pinned card goes in a column this wide: in the gutter beside the reading column
 * when both fit, floating with the transcript inset beside it when the column can spare the
 * room, else stacked above the transcript. Never over the text.
 */
export function summaryPlacement(width: number): SummaryPlacement {
  if (width >= column + 2 * summaryInset) return "gutter";
  if (width >= narrowest + summaryInset) return "inset";
  return "inline";
}

/** `summaryPlacement` for the element's width, kept as it resizes. */
export function useSummaryPlacement(element: RefObject<HTMLElement | null>): SummaryPlacement {
  const [placement, setPlacement] = useState<SummaryPlacement>("inset");
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    const measure = () => {
      if (node.offsetWidth > 0) setPlacement(summaryPlacement(node.offsetWidth));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [element]);
  return placement;
}

/**
 * The header's summary toggle (⌥⌘O): pins a small card with the thread at a glance (its
 * changes, subagents, sources and what waits on you) over the conversation's upper right. Kept
 * per thread. The number of opened tabs is the side panel toggle's, not this.
 */
export function SummaryToggle(props: { thread: ThreadRef }) {
  const pinned = useScopeWorkspace(props.thread.id).summaryPinned;
  const actions = useWorkspaceActions(props.thread.id);
  useHotkey(keymap.summary.keys, () => actions.setSummaryPinned(!pinned));
  return (
    <IconButton
      icon={ListBulletsIcon}
      label={pinned ? "Unpin thread summary" : "Pin thread summary"}
      shortcut="summary"
      pressed={pinned}
      onClick={() => actions.setSummaryPinned(!pinned)}
    />
  );
}

/**
 * The pinned summary card, while the toggle has it pinned: the project with its actions and git
 * menu, then the thread's changes, subagents and sources. `inline` stacks it at the top of a
 * column too narrow to float it beside the text.
 */
export function PinnedSummary(props: {
  thread: ThreadRef;
  inline: boolean;
  /** The composer's + menu, so a source is added where the message is written. */
  onAddSource(): void;
}) {
  const pinned = useScopeWorkspace(props.thread.id).summaryPinned;
  const actions = useWorkspaceActions(props.thread.id);
  const workspaceId = useThreadMeta(props.thread.id)?.workspaceId ?? props.thread.workspaceId;
  const project = useProjectName()(workspaceId);
  if (!pinned) return null;
  return (
    <aside
      aria-label="Thread summary"
      style={{ width: props.inline ? undefined : summaryWidth }}
      className={
        props.inline
          ? "glass fx-rise-in relative z-[6] m-4 mb-0 shrink-0 rounded-xl p-1.5 shadow-[var(--glass-shadow)]"
          : "glass fx-rise-in absolute top-3 right-4 z-[6] rounded-xl p-1.5 shadow-[var(--glass-shadow)]"
      }
    >
      <div className="flex h-8 items-center gap-0.5 pr-0.5 pl-2.5">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-muted-foreground">
          {project}
        </h2>
        <IconButton
          icon={PushPinSimpleSlashIcon}
          label="Unpin thread summary"
          shortcut="summary"
          size="sm"
          className="size-7"
          onClick={() => actions.setSummaryPinned(false)}
        />
        <SummaryMenu thread={props.thread} />
      </div>
      <Suspense fallback={<SkeletonText lines={4} className="px-2.5 py-2" />}>
        <DeferredSummaryBody.Component thread={props.thread} onAddSource={props.onAddSource} />
      </Suspense>
    </aside>
  );
}
