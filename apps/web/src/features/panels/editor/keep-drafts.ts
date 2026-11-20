import type { BufferRegistry, TextBuffer } from "@/features/editor-workbench/index.ts";
import { askUnsaved, type UnsavedAnswer } from "./unsaved-prompt.tsx";

/*
 * Hot exit (docs/editor/workbench.md 50): leaving the page or quitting the app never loses
 * unsaved editor text. Pending drafts are written when the page hides, and when the desktop app
 * quits it waits for them. Closing a browser tab asks only while the newest text is not yet on
 * the device: a draft write still out (typing just now), or one that failed (storage full or
 * unavailable). A desktop quit asks only after a failed write: the page tells the app its drafts
 * aren't kept, the quit stops, and the page asks Save, Don't save or Cancel, naming the files.
 */

interface DesktopDrafts {
  onFlush(listener: () => void): () => void;
  flushed(kept: boolean): Promise<void>;
  quit(): Promise<void>;
}

function member(owner: unknown, key: string): unknown {
  return typeof owner === "object" && owner !== null ? Reflect.get(owner, key) : undefined;
}

/** The desktop app's draft hooks (`window.ace.drafts`) and its quit, or undefined in a browser. */
function desktopDrafts(scope: object): DesktopDrafts | undefined {
  const ace: unknown = Reflect.get(scope, "ace");
  const drafts = member(ace, "drafts");
  const onFlush = member(drafts, "onFlush");
  const flushed = member(drafts, "flushed");
  const quit = member(member(ace, "app"), "quit");
  if (typeof onFlush !== "function" || typeof flushed !== "function") return undefined;
  return {
    onFlush: (listener) => {
      const off: unknown = onFlush(listener);
      return typeof off === "function" ? () => void off() : () => {};
    },
    flushed: async (kept) => void (await flushed(kept)),
    quit: async () => {
      if (typeof quit === "function") await quit();
    },
  };
}

export interface KeepDraftsOptions {
  target?: Window;
  /** Asks Save, Don't save or Cancel for files whose drafts couldn't be kept. */
  ask?: (paths: readonly string[]) => Promise<UnsavedAnswer>;
}

/** Keep `registries`' drafts through page hides and quits. Returns the undo. */
export function keepDrafts(
  registries: () => Iterable<BufferRegistry>,
  options: KeepDraftsOptions = {},
): () => void {
  const target = options.target ?? window;
  const ask = options.ask ?? askUnsaved;
  const flush = () => Promise.all([...registries()].map((registry) => registry.flushDrafts()));
  const unkept = (): TextBuffer[] => [...registries()].flatMap((registry) => registry.unkept());
  const hide = () => void flush();
  target.addEventListener("pagehide", hide);
  const desktop = desktopDrafts(target);
  // Leaving starts every pending draft write at once, and asks while any of them, or one that
  // failed, leaves the newest text off the device.
  const leave = (event: BeforeUnloadEvent) => {
    void flush();
    if (unkept().length > 0) event.preventDefault();
  };
  if (!desktop) target.addEventListener("beforeunload", leave);
  /** The quit stopped: the person decides about the files whose text isn't kept. */
  const decide = async (app: DesktopDrafts, buffers: readonly TextBuffer[]) => {
    const answer = await ask(buffers.map((buffer) => buffer.key.path));
    if (answer === "cancel") return;
    if (answer === "save") {
      const outcomes = await Promise.all(buffers.map((buffer) => buffer.save()));
      // A save that didn't land (a clash, offline) keeps the app open with the file unsaved.
      if (!outcomes.every((outcome) => outcome.kind === "saved" || outcome.kind === "unchanged"))
        return;
    } else await Promise.all(buffers.map((buffer) => buffer.discard()));
    await app.quit();
  };
  const off = desktop?.onFlush(() => {
    void flush()
      .catch(() => undefined)
      .then(async () => {
        const buffers = unkept();
        await desktop.flushed(buffers.length === 0).catch(() => undefined);
        if (buffers.length > 0) await decide(desktop, buffers);
      });
  });
  return () => {
    target.removeEventListener("pagehide", hide);
    target.removeEventListener("beforeunload", leave);
    off?.();
  };
}
