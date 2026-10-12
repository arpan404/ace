import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { Suspense, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { InteractionCard } from "../interactions/interaction-card.tsx";
import { usePendingAnswer } from "../interactions/pending-answers.ts";
import { AttachedCard } from "./attached-card.tsx";

/** Typing in these never cycles the stack. */
const typing = (target: EventTarget) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || target.tagName === "TEXTAREA" || target.tagName === "INPUT");

/**
 * The agent's open requests as a deck behind the composer's top edge: the first one to answer
 * on top, the rest peeking out above it. "1 of 3" with ‹ › (or [ and ] inside the card) moves
 * through them; answering one brings the next up. Escape goes back to the message. The
 * transcript keeps a line for each question; this is where they are answered.
 */
export function RequestStack(props: {
  threadId: string;
  ids: readonly string[];
  target?: string | undefined;
  /** Put the caret back in the message. */
  onLeave(): void;
}) {
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
    props.target !== undefined && props.ids.includes(props.target) ? props.target : undefined;
  const [seenTarget, setSeenTarget] = useState<string>();
  if (seenTarget !== targeted) {
    setSeenTarget(targeted);
    setPicked(targeted);
  }
  useEffect(() => {
    if (targeted && picked === targeted) frame.current?.focus();
  }, [targeted, picked]);
  const count = props.ids.length;
  // Stay on the request the person moved to while it is open; else the oldest.
  const at = Math.max(0, picked === undefined ? 0 : props.ids.indexOf(picked));
  const id = props.ids[at];
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
    setPicked(props.ids[(at + step + count) % count]);
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
    count > 1 ? (
      <span className="flex items-center gap-0.5 text-xs text-subtle-foreground tabular-nums">
        <IconButton
          size="sm"
          icon={CaretLeftIcon}
          label="Previous request"
          keys="["
          resolve={false}
          onClick={() => go(-1)}
        />
        <span aria-live="polite">
          {at + 1} of {count}
        </span>
        <IconButton
          size="sm"
          icon={CaretRightIcon}
          label="Next request"
          keys="]"
          resolve={false}
          onClick={() => go(1)}
        />
      </span>
    ) : undefined;
  const content = (
    <Suspense fallback={null}>
      <InteractionCard
        threadId={props.threadId}
        interactionId={id}
        frame="attached"
        aside={pager}
        onControlsChange={() => {
          if (!frame.current?.contains(document.activeElement)) return;
          // Question submission/reopening swaps article components. Hold focus outside them
          // until the new controls commit, then move into the replacement article.
          frame.current.focus({ preventScroll: true });
          setControlsRevision((revision) => revision + 1);
        }}
      />
    </Suspense>
  );
  const card = (
    <AttachedCard label="Waiting for you" behind={count - 1} cardKey={id}>
      {content}
    </AttachedCard>
  );
  return (
    <div
      ref={frame}
      tabIndex={-1}
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
      {card}
    </div>
  );
}
