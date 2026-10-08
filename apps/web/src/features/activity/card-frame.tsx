import { useSidebarThread } from "@ace/client-react";
import { DotsThreeIcon } from "@phosphor-icons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { cn } from "@/lib/cn.ts";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu.tsx";
import { SnoozeItems, useThreadActions } from "@/features/organize/index.ts";
import { useHotkey } from "@/lib/hotkeys.ts";
import { useNow } from "@/lib/time.ts";
import { formatAge } from "@ace/ui-core";
import { useActivityState } from "./activity-state.tsx";

/** The thread a card's request belongs to, from its key (`interaction:<thread>:<id>`). */
const threadOf = (cardKey: string) =>
  cardKey.startsWith("interaction:") ? cardKey.split(":")[1] : undefined;

/**
 * One Needs-you card: the context line (dot, project · thread, age, ⋯), the question at
 * 15/500 and the body. The focused card carries the accent ring and owns the A/D/1–3/O keys,
 * H (snooze) and X (pick); J/K move DOM focus to it, so a screen reader reads its title.
 */
export function CardFrame(props: {
  cardKey: string;
  /** The card's name, and its heading unless `heading` draws it. */
  title: string;
  heading?: ReactNode;
  context: string;
  at: number;
  children: ReactNode;
}) {
  const { focused, focusCard, picked, togglePicked } = useActivityState();
  const now = useNow();
  const isFocused = focused === props.cardKey;
  const isPicked = picked.has(props.cardKey);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (isFocused) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [isFocused]);
  useHotkey("x", () => togglePicked(props.cardKey), { enabled: isFocused });
  const threadId = threadOf(props.cardKey);
  return (
    <article
      ref={ref}
      tabIndex={-1}
      aria-label={props.title}
      aria-current={isFocused ? "true" : undefined}
      data-card-key={props.cardKey}
      onPointerDown={(event) => {
        if (event.shiftKey) togglePicked(props.cardKey);
        focusCard(props.cardKey);
      }}
      className={cn(
        "rounded-card px-[18px] py-4 shadow-[inset_0_0_0_1px_var(--border)] outline-none transition-shadow duration-(--dur-2)",
        (isFocused || isPicked) &&
          "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--ring)_55%,transparent),0_0_0_3px_color-mix(in_oklab,var(--ring)_14%,transparent)]",
        "focus-visible:shadow-[inset_0_0_0_2px_var(--focus,var(--ring))]",
      )}
    >
      <div className="flex items-center gap-[7px] text-sm text-muted-foreground">
        <Dot tone="needs-you" />
        <span className="min-w-0 truncate">{props.context}</span>
        {isPicked && <span className="shrink-0 font-medium text-foreground">Picked</span>}
        <span className="ml-auto shrink-0 tabular-nums">{formatAge(props.at, now)}</span>
        {threadId && <CardMenu threadId={threadId} focused={isFocused} />}
      </div>
      <h3 className="mt-2 mb-2.5 text-md leading-[1.35] font-medium tracking-[-0.005em]">
        {props.heading || props.title}
      </h3>
      {props.children}
    </article>
  );
}

/** The card's ⋯: snooze its thread (H on the focused card opens it). */
function CardMenu(props: { threadId: string; focused: boolean }) {
  const thread = useSidebarThread(props.threadId);
  const actions = useThreadActions();
  const now = useNow();
  const [open, setOpen] = useState(false);
  useHotkey("h", () => setOpen(true), { enabled: props.focused && thread !== undefined });
  if (!thread) return null;
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <IconButton
            icon={DotsThreeIcon}
            size="sm"
            label="Card actions"
            keys="h"
            resolve={false}
          />
        }
      />
      <MenuContent align="end">
        <SnoozeItems entry={thread} actions={actions} snoozed={(thread.snoozedUntil ?? 0) > now} />
      </MenuContent>
    </Menu>
  );
}

export function useCardFocused(cardKey: string): boolean {
  return useActivityState().focused === cardKey;
}

/** Actions row: optional leading control, a spacer, then buttons. */
export function CardActions(props: { lead?: ReactNode; children: ReactNode }) {
  return (
    <div className="mt-3.5 flex flex-wrap items-center gap-2">
      {props.lead}
      <span className="flex-1" />
      {props.children}
    </div>
  );
}

/** Key hint inside a button; on the ink primary button it is a plain dim letter. */
export function ButtonKey(props: { children: string; primary?: boolean }) {
  return (
    <Kbd aria-hidden variant={props.primary ? "on-primary" : "default"} className="ml-1">
      {props.children}
    </Kbd>
  );
}

export function CardError(props: { message: string | undefined }) {
  if (!props.message) return null;
  return (
    <p role="alert" className="mt-2.5 text-sm text-status-failed">
      {props.message}
    </p>
  );
}

export function useOpenThreadKey(threadId: string, focused: boolean) {
  const navigate = useNavigate();
  useHotkey("o", () => void navigate({ to: "/t/$threadId", params: { threadId } }), {
    enabled: focused,
  });
}

export function OpenThreadAction(props: { threadId: string; cardKey: string }) {
  useOpenThreadKey(props.threadId, useCardFocused(props.cardKey));
  return (
    <CardActions>
      <Link
        to="/t/$threadId"
        params={{ threadId: props.threadId }}
        className={buttonVariants({ variant: "ghost" })}
      >
        Open thread
        <ButtonKey>O</ButtonKey>
      </Link>
    </CardActions>
  );
}
