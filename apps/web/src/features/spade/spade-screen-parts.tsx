import { spadeStateLine, type SpadeAvatar } from "@ace/ui-core/spade-chat";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { LivePill, readingColumn } from "@/features/thread/index.ts";
import { usePresence } from "@/lib/motion.ts";
import { cn } from "@/lib/cn.ts";
import { SpadeFace } from "./spade-face.tsx";
import { useMarkSeen, type SeenTarget } from "./use-mark-seen.ts";
import { useSpadeEnabled } from "./use-spade-enabled.ts";
import { useSpadeStatus } from "./use-spade-status.ts";

/* What a bot's and a group's screens share: the scroller, the loading shape, a problem line. */

/** Spade's state line on this window's machine. */
export function useSpadeLine() {
  const [enabled] = useSpadeEnabled();
  return spadeStateLine(useSpadeStatus(), enabled);
}

const scrollerClass =
  "col-start-1 row-start-1 flex min-h-0 flex-col overflow-y-auto [scrollbar-gutter:stable_both-edges]";

/** The reading column, with room under the last line for the composer floating over it. */
const columnClass = cn(readingColumn, "w-full pb-[calc(var(--composer-clearance,0px)+1rem)]");

/**
 * A page over the composer that isn't a conversation yet (New bot): it opens at its top, so the
 * head is in view, and stays wherever the person scrolls it while its rows load.
 */
export function PageScroller(props: { children: ReactNode }) {
  return (
    <div className={scrollerClass}>
      <div className={cn(columnClass, "pt-6")}>{props.children}</div>
    </div>
  );
}

/** Keys that scroll a transcript up: pressing one lets go of its end. */
const readBackKeys = new Set(["ArrowUp", "PageUp", "Home"]);
/** Where those keys move between choices or through words instead. */
const controls = 'input, textarea, [contenteditable="true"], [role="radio"], [role="checkbox"]';

/** How near the end still counts as at it, in pixels. */
const endSlack = 48;

/**
 * A scroller that stays at its end while the person is there, as the conversation grows: on
 * every render and whenever the content's height changes after it. Scrolled up, it stays where
 * they are, however much arrives, and Scroll to end floats over the composer to take them back.
 * Each message they send (`sent` grows) brings them to the end, where it shows. A short
 * conversation starts at the top. With `seen`, being at the end marks the conversation seen
 * (`useMarkSeen`).
 */
export function Scroller(props: {
  /** What floats over its top: the pill of a bot's conversation, which the first line clears. */
  top?: "pill" | undefined;
  seen?: SeenTarget | undefined;
  /** How many messages the person sent from here; each new one goes to the end. */
  sent?: number | undefined;
  children: ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  /** Where it was last left (by following or a scroll), to tell the person's move up from ours. */
  const last = useRef({ top: 0, height: 0 });
  const [away, setAway] = useState(false);
  const pill = usePresence(away);
  const reportEnd = useMarkSeen(props.seen);
  /** The person moved up since we last looked: following lets go at once, however near the end. */
  const movedUp = (element: HTMLElement) =>
    element.scrollTop < last.current.top - 1 && element.scrollHeight >= last.current.height;
  const letGo = () => {
    atEnd.current = false;
    setAway(true);
    reportEnd(false);
  };
  /** At the end, it stays there as the conversation grows; unless the person just moved up. */
  const follow = () => {
    const element = scroller.current;
    if (!element || !atEnd.current) return;
    // A move up the scroll event hasn't told us of yet (a smooth scroll, a drag) still counts.
    if (movedUp(element)) return letGo();
    element.scrollTop = element.scrollHeight;
    last.current = { top: element.scrollTop, height: element.scrollHeight };
  };
  const toEnd = () => {
    atEnd.current = true;
    setAway(false);
    last.current = { top: 0, height: 0 };
    follow();
    reportEnd(true);
  };
  // A message the person sends shows where they look for it: at the end.
  const sent = useRef(props.sent);
  useLayoutEffect(() => {
    if (sent.current === props.sent) return;
    sent.current = props.sent;
    atEnd.current = true;
    last.current = { top: 0, height: 0 };
    setAway(false);
  }, [props.sent]);
  useLayoutEffect(follow);
  // It opens at its end.
  useEffect(() => reportEnd(atEnd.current), [reportEnd]);
  useLayoutEffect(() => {
    const inner = content.current;
    if (!inner || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => follow());
    observer.observe(inner);
    return () => observer.disconnect();
    // `follow` reads only refs: the first one is as good as any.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A wheel or trackpad turned up is the person reading back, before it even scrolls; so are the
  // keys that scroll up, from inside the transcript (not a card's options or fields, where they
  // move between choices).
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (event.deltaY < 0 && atEnd.current) letGo();
    };
    const key = (event: KeyboardEvent) => {
      const control = event.target instanceof Element && event.target.closest(controls);
      if (readBackKeys.has(event.key) && !control && atEnd.current) letGo();
    };
    element.addEventListener("wheel", wheel, { passive: true });
    element.addEventListener("keydown", key);
    return () => {
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("keydown", key);
    };
    // `letGo` reads refs and stable setters only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <div
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget;
          const up = movedUp(element);
          last.current = { top: element.scrollTop, height: element.scrollHeight };
          atEnd.current =
            !up && element.scrollHeight - element.scrollTop - element.clientHeight < endSlack;
          setAway(!atEnd.current);
          reportEnd(atEnd.current);
        }}
        className={scrollerClass}
      >
        <div ref={content} className={cn(columnClass, props.top === "pill" ? "pt-18" : "pt-6")}>
          {props.children}
        </div>
      </div>
      {pill.mounted && <LivePill newItems={0} more={false} phase={pill.phase} onClick={toEnd} />}
    </>
  );
}

/**
 * A bot's conversation before anything is said in it: who this is, as a club shows its members.
 * Its face at the profile's size, its name, and its task when it has one; no hint prose.
 */
export function ConversationStart(props: { avatar: SpadeAvatar; name: string; task: string }) {
  const task = props.task.trim();
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-2 text-center">
      <SpadeFace avatar={props.avatar} size={96} />
      <p className="mt-1 text-lg leading-7 font-semibold text-foreground">{props.name}</p>
      {task && <p className="line-clamp-3 max-w-[48ch] text-ui text-muted-foreground">{task}</p>}
    </div>
  );
}

export function ConversationSkeleton() {
  return (
    <LoadingRegion label="Conversation" className="flex flex-col gap-3">
      <Skeleton className="ml-auto h-9 w-48 rounded-lg" />
      <Skeleton className="h-14 w-3/4 rounded-lg" />
    </LoadingRegion>
  );
}

export function Problem(props: { text: string; onRetry(): void }) {
  return (
    <div role="alert" className="flex items-center gap-2 text-ui text-muted-foreground">
      <span className="min-w-0 flex-1">{props.text}</span>
      <Button size="xs" variant="ghost" onClick={props.onRetry}>
        Try again
      </Button>
    </div>
  );
}

export const message = (error: unknown) => (error instanceof Error ? error.message : "Try again.");
