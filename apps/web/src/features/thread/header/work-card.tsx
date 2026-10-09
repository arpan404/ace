import { useCallback, useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import type { ThreadRef } from "../sources/index.ts";
import { useCheckoutMove } from "./checkout-move.tsx";
import { useGitFlow } from "./use-git-flow.tsx";
import { ActionsSection } from "./work-card-actions.tsx";
import { ProjectRow } from "./work-card-environment.tsx";
import { ChangesSection } from "./work-card-git.tsx";
import { PullRequestsSection } from "./work-card-pr.tsx";
import { Rule, WorkSection } from "./work-card-parts.tsx";
import { ThreadEnvironmentCard } from "../composer/thread-environment.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { attachCardScroll } from "./work-card-scroll.ts";
import { WorkCardStateProvider, useWorkCardState } from "./work-card-state.tsx";
import { XIcon } from "@phosphor-icons/react";

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
        className="order-first max-h-[40dvh] min-h-0 w-full shrink-0 p-3 focus-ring-inset @min-[832px]/work-body:order-last @min-[832px]/work-body:h-full @min-[832px]/work-body:max-h-none @min-[832px]/work-body:w-[352px]"
      >
        <div
          data-work-card-surface
          className="flex max-h-[calc(40dvh-24px)] min-h-0 flex-col overflow-hidden rounded-xl border bg-panel p-2 @min-[832px]/work-body:max-h-[min(480px,100%)]"
        >
          <div className="flex shrink-0 items-center gap-1">
            <div className="min-w-0 flex-1">
              <ProjectRow thread={props.thread} move={checkout.move} onClose={close} />
            </div>
            <IconButton
              icon={XIcon}
              label="Close work card"
              tooltip={false}
              size="sm"
              onClick={() => props.onClose(true)}
            />
          </div>
          <CardScroll open={props.open}>
            <WorkSection id="work-card-environment" title="Environment">
              <ThreadEnvironmentCard thread={props.thread} />
            </WorkSection>
            <Rule />
            <WorkSection id="work-card-changes" title="Changes">
              <ChangesSection thread={props.thread} git={git} onClose={close} />
            </WorkSection>
            <Rule />
            <PullRequestsSection git={git} />
            <Rule />
            <ActionsSection thread={props.thread} onClose={props.onClose} />
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
