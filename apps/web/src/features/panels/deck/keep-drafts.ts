import type { BufferRegistry } from "@/features/editor-workbench/index.ts";

/*
 * Hot exit (docs/editor/workbench.md 50): leaving the page or quitting the app never loses
 * unsaved editor text. Pending drafts are written when the page hides, and when the desktop app
 * quits it waits for them. Closing a browser tab asks only while the newest text is not yet on
 * the device: a draft write still out (typing just now), or one that failed (storage full or
 * unavailable). The desktop app never blocks its own quit.
 */

interface DesktopDrafts {
  onFlush(listener: () => void): () => void;
  flushed(): Promise<void>;
}

function member(owner: unknown, key: string): unknown {
  return typeof owner === "object" && owner !== null ? Reflect.get(owner, key) : undefined;
}

/** The desktop app's draft hooks (`window.ace.drafts`), or undefined in a browser. */
function desktopDrafts(scope: object): DesktopDrafts | undefined {
  const drafts = member(Reflect.get(scope, "ace"), "drafts");
  const onFlush = member(drafts, "onFlush");
  const flushed = member(drafts, "flushed");
  if (typeof onFlush !== "function" || typeof flushed !== "function") return undefined;
  return {
    onFlush: (listener) => {
      const off: unknown = onFlush(listener);
      return typeof off === "function" ? () => void off() : () => {};
    },
    flushed: async () => void (await flushed()),
  };
}

/** Keep `registries`' drafts through page hides and quits. Returns the undo. */
export function keepDrafts(
  registries: () => Iterable<BufferRegistry>,
  target: Window = window,
): () => void {
  const flush = () => Promise.all([...registries()].map((registry) => registry.flushDrafts()));
  const hide = () => void flush();
  target.addEventListener("pagehide", hide);
  const desktop = desktopDrafts(target);
  // Leaving starts every pending draft write at once, and asks while any of them, or one that
  // failed, leaves the newest text off the device.
  const leave = (event: BeforeUnloadEvent) => {
    void flush();
    if ([...registries()].some((registry) => registry.unkept().length > 0)) event.preventDefault();
  };
  if (!desktop) target.addEventListener("beforeunload", leave);
  const off = desktop?.onFlush(() => {
    void flush()
      .catch(() => undefined)
      .finally(() => void desktop.flushed().catch(() => undefined));
  });
  return () => {
    target.removeEventListener("pagehide", hide);
    target.removeEventListener("beforeunload", leave);
    off?.();
  };
}
