import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import {
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { InteractionCard } from "../interactions/interaction-card.tsx";
import { usePendingAnswer } from "../interactions/pending-answers.ts";
import { DescendantCard, descendantKey } from "./descendant-card.tsx";
import type { DescendantRequest } from "./descendant-request.ts";

/** Typing in these never cycles the stack. */
const typing = (target: EventTarget) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || target.tagName === "TEXTAREA" || target.tagName === "INPUT");

/**
 * The agent's open requests in the composer's strip, the first one to answer showing. "1 of 3"
 * with ‹ › (or [ and ] inside the card) moves through them; answering one brings the next up.
 * Escape goes back to the message. The transcript keeps a line for each question; this is where
 * they are answered.
 */
export function RequestStack(props: {
  threadId: string;
  ids: readonly string[];
  /** A delegated child's request, shown first and answered here (see `descendantKey`). */
  descendant?: DescendantRequest | undefined;
  /** Messages the person queued, which wait for the asking child (`DescendantNote`). */
  queued?: number | undefined;
  target?: string | undefined;
  /** Put the caret back in the message. */
  onLeave(): void;
  /** The strip's other items, beside the pager. */
  indicators?: ReactNode;
}) {
  const { descendant } = props;
  const descendantId = descendant ? descendantKey(descendant) : undefined;
  const ids = descendantId ? [descendantId, ...props.ids] : props.ids;
  const [picked, setPicked] = useState<string>();
  const frame = useRef<HTMLDivElement>(null);
  const ownsFocus = useRef(false);
  const [controlsRevision, setControlsRevision] = useState(0);
  const leave = useRef(props.onLeave);
  useLayoutEffect(() => {
    leave.current = props.onLeave;
  }, [props.onLeave]);
  // The final request unmounts the stack. Restore the composer only if this deck owned focus.
  useLayoutEffect(
    () => () => {
      if (ownsFocus.current) leave.current();
    },
    [],
  );
  const targeted =
    props.target !== undefined && ids.includes(props.target) ? props.target : undefined;
  const [seenTarget, setSeenTarget] = useState<string>();
  if (seenTarget !== targeted) {
    setSeenTarget(targeted);
    setPicked(targeted);
  }
  useEffect(() => {
    if (targeted && picked === targeted) frame.current?.focus();
  }, [targeted, picked]);
  const count = ids.length;
  // Stay on the request the person moved to while it is open; else the oldest.
  const at = Math.max(0, picked === undefined ? 0 : ids.indexOf(picked));
  const id = ids[at];
  const pending = usePendingAnswer(id);
  useLayoutEffect(() => {
    if (!id || !ownsFocus.current) return;
    (frame.current?.querySelector<HTMLElement>("article") ?? frame.current)?.focus({
      preventScroll: true,
    });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Control replacement and submission signals require a focus handoff after commit.
  }, [id, pending, controlsRevision]);
  if (!id) return null;
  const go = (step: number) => {
    setPicked(ids[(at + step + count) % count]);
    // The old card's focused button unmounts when paging; keep subsequent [ / ] reachable.
    frame.current?.focus({ preventScroll: true });
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      props.onLeave();
      return;
    }
    if (count < 2 || typing(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "]" || event.key === "[") {
      event.preventDefault();
      go(event.key === "]" ? 1 : -1);
    }
  };
  const pager =
    count > 1 || props.indicators ? (
      <span className="flex items-center gap-3">
        {props.indicators}
        {count > 1 && <Pager at={at} count={count} go={go} />}
      </span>
    ) : undefined;
  const onControlsChange = () => {
    if (!frame.current?.contains(document.activeElement)) return;
    // Question submission/reopening swaps article components. Hold focus outside them
    // until the new controls commit, then move into the replacement article.
    frame.current.focus({ preventScroll: true });
    setControlsRevision((revision) => revision + 1);
  };
  const content =
    descendant && id === descendantId ? (
      <DescendantCard
        request={descendant}
        queued={props.queued ?? 0}
        aside={pager}
        onControlsChange={onControlsChange}
      />
    ) : (
      <Suspense fallback={null}>
        <InteractionCard
          threadId={props.threadId}
          interactionId={id}
          frame="attached"
          aside={pager}
          onControlsChange={onControlsChange}
        />
      </Suspense>
    );
  return (
    <div
      ref={frame}
      tabIndex={-1}
      role="region"
      aria-label="Waiting for you"
      // Focus here is on purpose (an answer focused on open, or the person's); a route's
      // title focus leaves it.
      data-request-stack=""
      onFocusCapture={() => {
        ownsFocus.current = true;
      }}
      onBlurCapture={(event) => {
        // Removed decision controls have no related target; submission moves to this frame.
        if (
          event.relatedTarget &&
          event.relatedTarget !== document.body &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          ownsFocus.current = false;
      }}
      onKeyDownCapture={onKeyDown}
      className="focus-ring"
    >
      {/* What it shows changing settles in place; the strip stays. */}
      <div key={id} className="fx-rise-in">
        {content}
      </div>
    </div>
  );
}

/** "1 of 3" with ‹ ›, [ and ] doing the same. */
function Pager(props: { at: number; count: number; go(step: number): void }) {
  return (
    <span className="flex items-center gap-0.5 text-xs text-subtle-foreground tabular-nums">
      <IconButton
        size="sm"
        icon={CaretLeftIcon}
        label="Previous request"
        keys="["
        resolve={false}
        onClick={() => props.go(-1)}
      />
      <span aria-live="polite">
        {props.at + 1} of {props.count}
      </span>
      <IconButton
        size="sm"
        icon={CaretRightIcon}
        label="Next request"
        keys="]"
        resolve={false}
        onClick={() => props.go(1)}
      />
    </span>
  );
}
