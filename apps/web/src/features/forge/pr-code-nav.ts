import { useEffect, useRef, useState, type RefObject } from "react";
import type { ForgeFile } from "@ace/protocol";

/** A conversation the Code tab can step to: on a file's line, or in the strip above the files. */
export interface CodeThreadStop {
  id: string;
  /** Its file, when it sits beside a line; none when it is in the strip. */
  path: string | undefined;
  resolved: boolean;
}

/** How far down the scroller a file's header must reach to be the one being read. */
const readingLine = 48;
/** Frames to wait for a file's rows to mount before giving up on a conversation in it. */
const settleFrames = 30;

/**
 * The next stop after `at` (or before it, going back), wrapping round; `unresolved` skips
 * resolved ones. Undefined when there is none.
 */
export function nextStop(
  stops: readonly CodeThreadStop[],
  at: string | undefined,
  step: 1 | -1,
  unresolved: boolean,
): CodeThreadStop | undefined {
  const shown = unresolved ? stops.filter((stop) => !stop.resolved) : stops;
  if (!shown.length) return undefined;
  const index = shown.findIndex((stop) => stop.id === at);
  if (index < 0) return step === 1 ? shown[0] : shown.at(-1);
  return shown[(index + step + shown.length) % shown.length];
}

function revealThread(scroller: HTMLElement | null, id: string, frames = settleFrames) {
  const element = scroller
    ?.closest("[data-pr-code]")
    ?.querySelector<HTMLElement>(`[data-pr-thread="${CSS.escape(id)}"]`);
  if (element) {
    const strip = element.closest("details");
    if (strip) strip.open = true;
    element.scrollIntoView?.({ block: "center" });
    return;
  }
  if (frames > 0) requestAnimationFrame(() => revealThread(scroller, id, frames - 1));
}

/**
 * Moving through the Code tab: the file being read (the last whose header passed the top),
 * going to a file even when its page isn't read yet (pages load until it is found), and
 * stepping through conversations. `show` opens a loaded file and scrolls to it.
 */
export function useCodeNavigation(options: {
  files: readonly ForgeFile[];
  more: "done" | "failed" | "loading" | "idle";
  loadMore(): void;
  show(path: string): boolean;
  scroller: RefObject<HTMLElement | null>;
  anchor: string;
  onPlace?: ((path: string) => void) | undefined;
}) {
  const { files, more, loadMore, show, scroller, anchor, onPlace } = options;
  const [seeking, setSeeking] = useState<{ path: string; thread?: string | undefined }>();
  const [current, setCurrent] = useState<string>();
  const lastThread = useRef<string | undefined>(undefined);
  const handled = useRef<object | undefined>(undefined);
  const go = (path: string, thread?: string) => {
    setCurrent(path);
    if (!files.some((file) => file.path === path)) {
      setSeeking({ path, thread });
      return;
    }
    show(path);
    if (thread) requestAnimationFrame(() => revealThread(scroller.current, thread));
  };
  const found = !!seeking && files.some((file) => file.path === seeking.path);
  // A file past the pages read: read on until it shows up, or the list ends without it.
  useEffect(() => {
    if (!seeking || handled.current === seeking) return;
    if (found) {
      handled.current = seeking;
      show(seeking.path);
      const thread = seeking.thread;
      if (thread) requestAnimationFrame(() => revealThread(scroller.current, thread));
    } else if (more === "idle") loadMore();
  });
  // The file being read follows the scroll.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let frame = 0;
    let last: string | undefined;
    const measure = () => {
      frame = 0;
      const top = element.getBoundingClientRect().top + readingLine;
      let reading: string | undefined;
      for (const block of element.querySelectorAll<HTMLElement>(`section[id^="${anchor}-"]`)) {
        if (block.getBoundingClientRect().top > top) break;
        reading = files[Number(block.id.slice(anchor.length + 1))]?.path;
      }
      if (!reading || reading === last) return;
      last = reading;
      setCurrent(reading);
      onPlace?.(reading);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      element.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scroller, anchor, files, onPlace]);
  const stepFile = (step: 1 | -1) => {
    const index = files.findIndex((file) => file.path === current);
    const next = files[index < 0 ? (step === 1 ? 0 : files.length - 1) : index + step];
    if (next) go(next.path);
    else if (step === 1 && more === "idle") loadMore();
  };
  const stepThread = (stops: readonly CodeThreadStop[], step: 1 | -1, unresolved: boolean) => {
    const stop = nextStop(stops, lastThread.current, step, unresolved);
    if (!stop) return;
    lastThread.current = stop.id;
    if (stop.path) go(stop.path, stop.id);
    else revealThread(scroller.current, stop.id);
  };
  const searching = !!seeking && !found && (more === "idle" || more === "loading");
  return { current, go, seeking: searching ? seeking.path : undefined, stepFile, stepThread };
}
