import { Popover, PopoverContent } from "@/components/ui/popover.tsx";
import { MenuItem, MenuSeparator } from "@/components/ui/menu.tsx";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  lazy,
  Suspense,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useThreadMeta } from "@ace/client-react";
import { useElementWidth } from "@/lib/use-element-width.ts";
import { WorkAutomations } from "@/features/automations/index.ts";
import { fileTab, loadCreateFile } from "@/features/panels/index.ts";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { cn } from "@/lib/cn.ts";
import type { ThreadRef } from "../sources/index.ts";
import { useCheckoutMove } from "./checkout-move.tsx";
import { useGitFlow } from "./use-git-flow.tsx";
import { WorkCardActivity } from "./work-card-activity.tsx";
import { ProjectRow } from "./work-card-environment.tsx";
import { BranchRow, ChangesSection, GitMenuItems } from "./work-card-git.tsx";
import { PullRequestsSection } from "./work-card-pr.tsx";
import { attachCardScroll } from "./work-card-scroll.ts";
import { WorkCardStateProvider, useWorkCardState } from "./work-card-state.tsx";

const CreateFile = lazy(() => loadCreateFile().then((module) => ({ default: module.CreateFile })));

/** Floating checkout and activity details, with one scroll surface at every width. */
export function WorkCard(props: {
  thread: ThreadRef;
  open: boolean;
  onClose(returnFocus: boolean): void;
}) {
  const git = useGitFlow(props.thread);
  const details = useThreadMeta(props.thread.id)?.details;
  const [measure, width] = useElementWidth();
  const wide = width >= 1060;
  const [linking, setLinking] = useState(false);
  const [addingScript, setAddingScript] = useState(false);
  const workspace = useWorkspaceActions(props.thread.id);
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
  const content = (
    <aside
      ref={surface}
      id="work-card"
      aria-label="Work card"
      hidden={!props.open}
      tabIndex={-1}
      onKeyDown={escape}
      className="flex min-h-0 flex-col focus-ring-inset"
    >
      <div data-work-card-surface className="flex min-h-0 flex-col bg-popover">
        <CardScroll open={props.open} wide={wide}>
          <ProjectRow
            thread={props.thread}
            move={checkout.move}
            onClose={close}
            onAddScript={() => {
              setAddingScript(true);
              close();
            }}
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
          <section aria-label="Source control" className="py-3">
            <BranchRow thread={props.thread} git={git} move={checkout.move} />
            <PullRequestsSection
              git={menuGit}
              linking={linking}
              onLinkClose={() => setLinking(false)}
            />
            <ChangesSection thread={props.thread} git={git} onClose={close} />
          </section>
          <WorkAutomations
            workspaceId={props.thread.workspaceId}
            workspacePath={details?.workspace?.path}
            onClose={close}
          />
          <WorkCardActivity threadId={props.thread.id} onClose={close} />
        </CardScroll>
      </div>
    </aside>
  );
  return (
    <WorkCardStateProvider scope={props.thread.id}>
      {/* Measure the work area's container, so resizing the transcript cannot toggle the layout. */}
      <div ref={measure} aria-hidden className="pointer-events-none absolute inset-0" />
      {wide ? (
        props.open && (
          <div
            data-work-card-docked
            className="flex min-h-0 w-[calc(var(--work-details-width)+2*var(--surface-inset))] shrink-0 flex-col px-(--surface-inset) py-6"
          >
            <div className="flex min-h-0 max-h-full flex-col overflow-hidden rounded-xl border bg-popover shadow-raised">
              {content}
            </div>
          </div>
        )
      ) : (
        <Popover
          open={props.open}
          onOpenChange={(open, event) => {
            if (!open) props.onClose(event.reason === "escape-key");
          }}
        >
          <PopoverContent
            anchor={() => document.querySelector<HTMLElement>("header [data-work-card-toggle]")}
            aria-label="Work details"
            side="bottom"
            align="end"
            className="w-(--work-details-width) p-0 overflow-hidden rounded-xl"
            initialFocus={surface}
            finalFocus={false}
          >
            {content}
          </PopoverContent>
        </Popover>
      )}
      {git.dialog}
      {checkout.dialog}
      {addingScript && (
        <Suspense fallback={null}>
          <CreateFile
            threadId={props.thread.id}
            onClose={() => setAddingScript(false)}
            onCreated={(path) => workspace.open(fileTab(path))}
          />
        </Suspense>
      )}
    </WorkCardStateProvider>
  );
}

/** Restore once asynchronous content can contain the saved position. */
function CardScroll(props: { open: boolean; wide: boolean; children: ReactNode }) {
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
      className={cn(
        "min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain",
        props.wide ? "max-h-full" : "max-h-[min(70dvh,calc(var(--available-height)_-_2px))]",
      )}
    >
      <div className="divide-y divide-border [&>section]:px-3">{props.children}</div>
    </div>
  );
}
