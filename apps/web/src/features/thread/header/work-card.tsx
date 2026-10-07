import { useEffect, useRef, type ReactNode } from "react";
import { usePhone } from "@/lib/breakpoints.ts";
import type { ThreadRef } from "../sources/index.ts";
import { useGitFlow } from "./use-git-flow.tsx";
import { ActionsSection } from "./work-card-actions.tsx";
import { ProjectRow } from "./work-card-environment.tsx";
import { ChangesSection, PullRequestsSection } from "./work-card-git.tsx";
import { OpenInSection } from "./work-card-open-in.tsx";
import { SourcesSection } from "./work-card-sources.tsx";
import { Rule } from "./work-card-parts.tsx";

/** The phone sheet's scrim and both shapes' sizes (inline: one-off values, ADR 0056 CSS budget). */
const scrim = { background: "color-mix(in oklab, black 40%, transparent)" };
const sheetSize = {
  maxHeight: "85dvh",
  paddingBottom: "max(env(safe-area-inset-bottom), 12px)",
};
const floatingSize = { width: 352, maxWidth: "calc(100% - 24px)", maxHeight: "calc(100% - 16px)" };

/** Popups the card opens (its menus, the commit form) and its toggle: clicks there keep it open. */
const ownPopups =
  '[role="menu"], [role="dialog"], [role="listbox"], [data-slot="tooltip-content"], [data-work-card-toggle]';

/**
 * The thread's work card, toggled by the list button in the header (⌥⌘O): the project, its
 * changes and branch with Commit & push, pull requests, the project's actions (scripts) to run,
 * the apps to open the checkout in, and the tool sources its agents have. It floats under the
 * header's right end, over the conversation; on a phone it is a sheet. A click outside it or
 * Escape closes it, and it keeps nothing between openings.
 *
 * Mounted from its first opening on, so a commit form it opened outlives the card closing.
 */
export function WorkCard(props: {
  thread: ThreadRef;
  open: boolean;
  /** Close it; `returnFocus` puts focus back on the header's toggle (Escape). */
  onClose(returnFocus: boolean): void;
}) {
  const git = useGitFlow(props.thread);
  const close = () => props.onClose(false);
  return (
    <>
      {props.open && (
        <Floating onClose={props.onClose}>
          <ProjectRow thread={props.thread} onClose={close} />
          <ChangesSection thread={props.thread} git={git} onClose={close} />
          <Rule />
          <PullRequestsSection git={git} onClose={close} />
          <Rule />
          <ActionsSection thread={props.thread} onClose={props.onClose} />
          <Rule />
          <OpenInSection thread={props.thread} onClose={close} />
          <Rule />
          <SourcesSection thread={props.thread} onClose={close} />
        </Floating>
      )}
      {git.dialog}
    </>
  );
}

/** The card's surface: floating under the header, or a sheet on a phone; dismissed from outside. */
function Floating(props: { onClose(returnFocus: boolean): void; children: ReactNode }) {
  const phone = usePhone();
  const card = useRef<HTMLDivElement>(null);
  const { onClose } = props;
  useEffect(() => {
    card.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const outside = (target: EventTarget | null) =>
      target instanceof Element && !card.current?.contains(target) && !target.closest(ownPopups);
    const down = (event: PointerEvent) => {
      if (outside(event.target)) onClose(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // A menu or form the card opened closes first.
      const target = event.target instanceof Element ? event.target : null;
      if (target && !card.current?.contains(target) && target.closest(ownPopups)) return;
      onClose(true);
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);
  return (
    <>
      {phone && <div aria-hidden style={scrim} className="fx-fade-in fixed inset-0 z-40" />}
      {/* An elevated, opaque surface: the transcript never reads through it. */}
      <div
        ref={card}
        id="work-card"
        role="dialog"
        aria-label="Work card"
        tabIndex={-1}
        style={phone ? sheetSize : floatingSize}
        className={
          phone
            ? "fx-rise-in fixed inset-x-0 bottom-0 z-40 flex flex-col overflow-y-auto rounded-t-xl bg-popover px-2 shadow-glass outline-none"
            : "isolate fx-rise-in absolute top-2 right-3 z-10 flex flex-col overflow-y-auto rounded-xl bg-popover p-2 shadow-glass outline-none"
        }
      >
        {phone && (
          <span aria-hidden className="mx-auto mt-2 mb-1 h-1 w-9 shrink-0 rounded-full bg-border" />
        )}
        {props.children}
      </div>
    </>
  );
}
