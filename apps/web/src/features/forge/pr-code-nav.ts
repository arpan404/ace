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

/** How long a conversation or line just landed on stays marked. */
const landedFor = 1_800;

/** Briefly marks what a jump landed on, so the eye finds it after the scroll. */
function markLanded(element: HTMLElement) {
  element.classList.remove("fx-landed");
  // Restart the fade when the same place is landed on twice in a row.
  void element.offsetWidth;
  element.classList.add("fx-landed");
  setTimeout(() => element.classList.remove("fx-landed"), landedFor);
}

/** Scrolls to an element once it mounts (a file's rows can take frames), then marks it. */
function reveal(find: () => HTMLElement | null | undefined, frames = settleFrames) {
  const element = find();
  if (element) {
    const strip = element.closest("details");
    if (strip) strip.open = true;
    element.scrollIntoView?.({ block: "center" });
    markLanded(element);
    return;
  }
  if (frames > 0) requestAnimationFrame(() => reveal(find, frames - 1));
}

function revealThread(scroller: HTMLElement | null, id: string) {
  reveal(() =>
    scroller
      ?.closest("[data-pr-code]")
      ?.querySelector<HTMLElement>(`[data-pr-thread="${CSS.escape(id)}"]`),
  );
}

/** A line of the file's new side (the row it sits in), in the file's block. */
function revealLine(block: () => HTMLElement | null, line: number) {
  reveal(
    () =>
      block()?.querySelector<HTMLElement>(`[data-side="new"][data-line="${line}"]`)?.parentElement,
  );
}

/** Where in a file a jump lands: a conversation on it, else one of its lines. */
export type CodeLanding = { thread: string } | { line: number };

/**
 * Where a jump to a file's line lands: the conversation on that line when there is one (an
 * open one first), else the line itself; nowhere in particular without a line.
 */
export function landingOf(
  focus: { path: string; line?: number | undefined },
  threads: readonly { id: string; file: string; line: number | null; resolved: boolean }[],
): CodeLanding | undefined {
  if (focus.line === undefined) return undefined;
  const on = threads.filter((t) => t.file === focus.path && t.line === focus.line);
  const thread = on.find((t) => !t.resolved) ?? on[0];
  return thread ? { thread: thread.id } : { line: focus.line };
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
  const [seeking, setSeeking] = useState<{ path: string; at?: CodeLanding | undefined }>();
  const [current, setCurrent] = useState<string>();
  const lastThread = useRef<string | undefined>(undefined);
  const handled = useRef<object | undefined>(undefined);
  const land = (path: string, at: CodeLanding | undefined) => {
    if (!at) return;
    if ("thread" in at) requestAnimationFrame(() => revealThread(scroller.current, at.thread));
    else {
      const index = files.findIndex((file) => file.path === path);
      revealLine(() => document.getElementById(`${anchor}-${index}`), at.line);
    }
  };
  const go = (path: string, at?: CodeLanding) => {
    setCurrent(path);
    if (!files.some((file) => file.path === path)) {
      setSeeking({ path, at });
      return;
    }
    show(path);
    land(path, at);
  };
  const found = !!seeking && files.some((file) => file.path === seeking.path);
  // A file past the pages read: read on until it shows up, or the list ends without it.
  useEffect(() => {
    if (!seeking || handled.current === seeking) return;
    if (found) {
      handled.current = seeking;
      show(seeking.path);
      land(seeking.path, seeking.at);
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
    if (stop.path) go(stop.path, { thread: stop.id });
    else revealThread(scroller.current, stop.id);
  };
  const searching = !!seeking && !found && (more === "idle" || more === "loading");
  return { current, go, seeking: searching ? seeking.path : undefined, stepFile, stepThread };
}
