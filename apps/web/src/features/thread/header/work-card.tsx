import { useCallback, useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import type { ThreadRef } from "../sources/index.ts";
import { useCheckoutMove } from "./checkout-move.tsx";
import { useGitFlow } from "./use-git-flow.tsx";
import { WorkCardActivity } from "./work-card-activity.tsx";
import { ProjectRow } from "./work-card-environment.tsx";
import { ChangesSection } from "./work-card-git.tsx";
import { PullRequestsSection } from "./work-card-pr.tsx";
import { attachCardScroll } from "./work-card-scroll.ts";
import { WorkCardStateProvider, useWorkCardState } from "./work-card-state.tsx";

/** Inline context beside the conversation, stacked above it when its body is narrow. */
export function WorkCard(props: {
  thread: ThreadRef;
  open: boolean;
  onClose(returnFocus: boolean): void;
}) {
  const git = useGitFlow(props.thread);
  const surface = useRef<HTMLElement>(null);
  useEffect(() => {
    if (props.open) surface.current?.focus({ preventScroll: true });
  }, [props.open]);
  const checkout = useCheckoutMove(props.thread);
  const close = () => props.onClose(false);
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    props.onClose(true);
  };
  return (
    <WorkCardStateProvider scope={props.thread.id}>
      <aside
        ref={surface}
        id="work-card"
        aria-label="Work card"
        hidden={!props.open}
        tabIndex={-1}
        onKeyDown={escape}
        className="order-first min-h-0 w-full shrink-0 p-2 focus-ring-inset @min-[832px]/work-body:order-last @min-[832px]/work-body:h-full @min-[832px]/work-body:w-[248px]"
      >
        <div
          data-work-card-surface
          className="ml-auto flex max-h-[92px] w-[232px] max-w-full min-h-0 flex-col overflow-hidden rounded-lg border bg-panel p-1 @min-[832px]/work-body:max-h-[min(300px,100%)]"
        >
          <CardScroll open={props.open}>
            <ProjectRow thread={props.thread} move={checkout.move} onClose={close} />
            <ChangesSection thread={props.thread} git={git} onClose={close} />
            <PullRequestsSection git={git} />
            <WorkCardActivity threadId={props.thread.id} onClose={close} />
          </CardScroll>
        </div>
      </aside>
      {git.dialog}
      {checkout.dialog}
    </WorkCardStateProvider>
  );
}

/** Restore once asynchronous content can contain the saved position. */
function CardScroll(props: { open: boolean; children: ReactNode }) {
  const { state, update } = useWorkCardState();
  const saved = state.scrollTop ?? 0;
  const open = props.open;
  const scroll = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node || !open) return;
      return attachCardScroll(node, saved, (scrollTop) => update({ scrollTop }));
    },
    [open, saved, update],
  );
  return (
    <div
      ref={scroll}
      data-work-card-scroll
      className="min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain"
    >
      <div>{props.children}</div>
    </div>
  );
}
