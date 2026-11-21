import type { DroppedOutputLine } from "./bounded-line-framing.ts";

export type DroppedLineNotes = {
  /** Feed every drop the spawn reports; a split line counts once, at its final size. */
  dropped(line: DroppedOutputLine): void;
  /** Report what is still pending and stop the timer, as when the process exits. */
  flush(): void;
};

/**
 * Bounded diagnostics for dropped stderr lines. The first drop is noted at once; later ones
 * within `intervalMs` are summed into one note when the interval ends, so a flood of
 * oversized lines adds at most one note per interval to its owner's mailbox.
 */
export function droppedLineNotes(options: {
  note: (text: string) => void;
  schedule: (run: () => void, ms: number) => () => void;
  intervalMs?: number;
}): DroppedLineNotes {
  const intervalMs = options.intervalMs ?? 1000;
  let lines = 0;
  let bytes = 0;
  let cancel: (() => void) | undefined;
  const report = () => {
    if (!lines) return false;
    options.note(
      lines === 1
        ? `ace dropped a stderr line of ${bytes} bytes`
        : `ace dropped ${lines} stderr lines, ${bytes} bytes in total`,
    );
    lines = 0;
    bytes = 0;
    return true;
  };
  const open = () => {
    cancel = options.schedule(() => {
      cancel = undefined;
      if (report()) open();
    }, intervalMs);
  };
  return {
    dropped(line) {
      if (line.phase === "start") return;
      lines++;
      bytes += line.bytes;
      if (cancel) return;
      report();
      open();
    },
    flush() {
      cancel?.();
      cancel = undefined;
      report();
    },
  };
}
