import type { AutoSaveMode } from "@/lib/editor-preferences.ts";

/*
 * Auto save (spec 51, Settings › Editor): off, after typing pauses, or when an editor loses focus.
 * It saves through the buffer's own versioned write. A save that meets someone else's change
 * never asks anything: the buffer raises the agent notice (case 46) as it does for any save, and
 * this file stops auto-saving until the person saves it by hand. Pure apart from the injected
 * timer.
 */

/** What auto save needs of a file's buffer. */
export interface AutoSaveFile {
  snapshot(): { dirty: boolean; clash: unknown };
  /** The buffer's save; only a clash and a failure's message matter here. */
  save(): Promise<{ kind: string } | { kind: "failed"; message: string }>;
}

export interface AutoSave {
  configure(settings: { mode: AutoSaveMode; delay: number }): void;
  /** The person typed in the file. */
  edited(path: string): void;
  /** The file's editor lost focus. */
  blurred(path: string): void;
  /** The person saved the file themselves: auto save may resume for it. */
  savedByHand(path: string): void;
  /** Whether the daemon is reachable: offline, nothing is tried (the panel saves on return). */
  setOnline(online: boolean): void;
  dispose(): void;
}

export function createAutoSave(options: {
  schedule(run: () => void, ms: number): () => void;
  file(path: string): AutoSaveFile | undefined;
  /** A save failed for another reason than a clash (the disk, the connection). */
  failed(path: string, message: string): void;
}): AutoSave {
  let settings: { mode: AutoSaveMode; delay: number } = { mode: "off", delay: 1000 };
  let online = true;
  const waiting = new Map<string, () => void>();
  /** Files whose auto save met someone else's change. */
  const stopped = new Set<string>();

  const cancel = (path: string) => {
    waiting.get(path)?.();
    waiting.delete(path);
  };

  const save = async (path: string) => {
    const file = options.file(path);
    if (!file || stopped.has(path) || !online) return;
    const snapshot = file.snapshot();
    if (!snapshot.dirty || snapshot.clash) return;
    const outcome = await file.save();
    if (outcome.kind === "clash") stopped.add(path);
    else if ("message" in outcome) options.failed(path, outcome.message);
  };

  return {
    configure(next) {
      settings = next;
      if (next.mode !== "pause") for (const path of waiting.keys()) cancel(path);
    },
    edited(path) {
      if (settings.mode !== "pause" || stopped.has(path)) return;
      cancel(path);
      waiting.set(
        path,
        options.schedule(() => {
          waiting.delete(path);
          void save(path);
        }, settings.delay),
      );
    },
    blurred(path) {
      if (settings.mode === "focus") void save(path);
    },
    savedByHand(path) {
      stopped.delete(path);
    },
    setOnline(next) {
      online = next;
    },
    dispose() {
      for (const path of waiting.keys()) cancel(path);
    },
  };
}
