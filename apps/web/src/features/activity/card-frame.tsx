import { Link, useNavigate } from "@tanstack/react-router";
import { cn } from "@/lib/cn.ts";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { useHotkey } from "@/lib/hotkeys.ts";
import { useNow } from "@/lib/time.ts";
import { formatAge } from "@ace/ui-core";
import { useActivityState } from "./activity-state.tsx";

/**
 * One Needs-you card: the context line (dot, project · thread, age), the question at 15/500
 * and the body. The focused card carries the accent ring and owns the A/D/1–3/O keys.
 */
export function CardFrame(props: {
  cardKey: string;
  title: string;
  context: string;
  at: number;
  children: ReactNode;
}) {
  const { focused, setFocused } = useActivityState();
  const now = useNow();
  const isFocused = focused === props.cardKey;
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (isFocused) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [isFocused]);
  return (
    <article
      ref={ref}
      aria-label={props.title}
      aria-current={isFocused ? "true" : undefined}
      data-card-key={props.cardKey}
      onPointerDown={() => setFocused(props.cardKey)}
      className={cn(
        "rounded-[12px] px-[18px] py-4 shadow-[inset_0_0_0_1px_var(--border)] transition-shadow duration-(--dur-2)",
        isFocused &&
          "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--ring)_55%,transparent),0_0_0_3px_color-mix(in_oklab,var(--ring)_14%,transparent)]",
      )}
    >
      <div className="flex items-center gap-[7px] text-[12px] text-subtle-foreground">
        <Dot tone="needs-you" />
        <span className="min-w-0 truncate">{props.context}</span>
        <span className="ml-auto shrink-0 tabular-nums">{formatAge(props.at, now)}</span>
      </div>
      <h3 className="mt-2 mb-2.5 text-md leading-[1.35] font-medium tracking-[-0.005em]">
        {props.title}
      </h3>
      {props.children}
    </article>
  );
}

export function useCardFocused(cardKey: string): boolean {
  return useActivityState().focused === cardKey;
}

export function CommandBlock(props: { command: string }) {
  return (
    <pre className="rounded-md bg-code px-3 py-[9px] font-mono text-[12.5px] leading-normal whitespace-pre-wrap text-foreground">
      {props.command}
    </pre>
  );
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
