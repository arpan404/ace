import { Popover, PopoverContent } from "@/components/ui/popover.tsx";
import { MenuItem, MenuSeparator } from "@/components/ui/menu.tsx";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { ThreadRef } from "../sources/index.ts";
import { useCheckoutMove } from "./checkout-move.tsx";
import { useGitFlow } from "./use-git-flow.tsx";
import { WorkCardActivity } from "./work-card-activity.tsx";
import { ProjectRow } from "./work-card-environment.tsx";
import { ChangesSection, GitMenuItems } from "./work-card-git.tsx";
import { PullRequestsSection } from "./work-card-pr.tsx";
import { attachCardScroll } from "./work-card-scroll.ts";
import { WorkCardStateProvider, useWorkCardState } from "./work-card-state.tsx";

/** Floating checkout and activity details, with one scroll surface at every width. */
export function WorkCard(props: {
  thread: ThreadRef;
  open: boolean;
  onClose(returnFocus: boolean): void;
}) {
  const git = useGitFlow(props.thread);
  const [linking, setLinking] = useState(false);
  const surface = useRef<HTMLElement>(null);
  useEffect(() => {
    if (props.open) surface.current?.focus({ preventScroll: true });
  }, [props.open]);
  const checkout = useCheckoutMove(props.thread);
  const close = () => props.onClose(false);
  const menuGit = {
    ...git,
    open: (kind: Parameters<typeof git.open>[0]) => {
      git.open(kind);
      close();
    },
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    props.onClose(true);
  };
  return (
    <WorkCardStateProvider scope={props.thread.id}>
      <Popover
        open={props.open}
        onOpenChange={(open) => {
          if (!open) props.onClose(true);
        }}
      >
        <PopoverContent
          anchor={() => document.querySelector<HTMLElement>("header [data-work-card-toggle]")}
          aria-label="Work details"
          side="bottom"
          align="end"
          className="w-(--work-details-width) p-0 overflow-hidden"
          initialFocus={surface}
          finalFocus={false}
        >
          <aside
            ref={surface}
            id="work-card"
            aria-label="Work card"
            hidden={!props.open}
            tabIndex={-1}
            onKeyDown={escape}
            className="min-h-0 focus-ring-inset"
          >
            <div
              data-work-card-surface
              className="flex min-h-0 flex-col bg-popover p-(--surface-inset)"
            >
              <CardScroll open={props.open}>
                <ProjectRow
                  thread={props.thread}
                  move={checkout.move}
                  onClose={close}
                  menuFocus={() =>
                    linking
                      ? (surface.current?.querySelector<HTMLInputElement>(
                          '[aria-label="Link pull request…"]',
                        ) ?? false)
                      : !git.dialog
                  }
                  actions={
                    <>
                      {git.checkout && (
                        <>
                          <MenuSeparator />
                          <GitMenuItems git={menuGit} checkout={git.checkout} />
                        </>
                      )}
                      {git.checkout?.repository?.forge !== "gitlab" && (
                        <>
                          <MenuSeparator />
                          <MenuItem
                            disabled={!!git.linkBlocked || git.pending}
                            reason={git.linkBlocked}
                            onClick={() => setLinking(true)}
                          >
                            Link a pull request
                          </MenuItem>
                        </>
                      )}
                    </>
                  }
                />
                <ChangesSection thread={props.thread} git={git} onClose={close} />
                <PullRequestsSection
                  git={menuGit}
                  linking={linking}
                  onLinkClose={() => setLinking(false)}
                />
                <WorkCardActivity threadId={props.thread.id} onClose={close} />
              </CardScroll>
            </div>
          </aside>
        </PopoverContent>
      </Popover>
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
      className="max-h-[min(70dvh,var(--available-height))] min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain"
    >
      <div className="space-y-(--surface-gap)">{props.children}</div>
    </div>
  );
}
