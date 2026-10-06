import { LockSimpleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Dot } from "@/components/ui/dot.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { keymap } from "@/lib/keymap.ts";
import { useBrowserDriver } from "../preview/use-browser-driver.ts";
import type { BrowserView, PreviewSource } from "../sources.ts";

const action =
  "h-6 shrink-0 rounded-sm px-2 font-medium text-foreground focus-ring hover:bg-accent disabled:opacity-50";

/**
 * Who has the page: the agent (named from the thread's tree), this device, or nobody yet, with
 * Take control / Hand back. A private takeover hides the page from agents entirely: they can't
 * see, read or record it until you hand it back, even if this window disconnects meanwhile.
 */
export function ControlStrip(props: {
  view: BrowserView;
  busy: boolean;
  onToggle(): void;
  onPrivate(): void;
}) {
  const driver = useBrowserDriver(props.view.threadId);
  const { view } = props;
  const privately = view.takeoverMode === "private";
  let text;
  let mark;
  if (privately && view.controller !== "human") {
    // Disconnected while private: the gate holds, nobody drives until you take it back.
    mark = <LockSimpleIcon aria-hidden size={13} className="text-status-needs-you" />;
    text = <>Private and paused · agents can't see this page until you hand it back</>;
  } else if (view.status === "paused" || view.status === "recovering") {
    mark = view.status === "recovering" ? <Spinner /> : <Dot tone="needs-you" />;
    text = (
      <>
        {view.status === "recovering" ? "Reconnecting the browser" : "The browser is paused"}
        {view.reason && ` · ${view.reason}`}
      </>
    );
  } else if (view.controller === "human" && privately) {
    mark = <LockSimpleIcon aria-hidden size={13} className="text-status-needs-you" />;
    text = (
      <>
        <b className="font-medium text-foreground">Private</b> · agents can't see, read or record
        this page until you hand it back
      </>
    );
  } else if (view.controller === "human") {
    mark = <Dot tone="needs-you" />;
    text = (
      <>
        <b className="font-medium text-foreground">You</b> have control · agents wait until you hand
        it back
      </>
    );
  } else {
    mark = <Spinner className="text-status-working" />;
    text = (
      <>
        <b className="font-medium text-foreground">{driver ?? "An agent"}</b> is using this page
      </>
    );
  }
  const stopped = (view.status === "paused" || view.status === "recovering") && !privately;
  return (
    <div
      role="status"
      className="flex h-8 shrink-0 items-center gap-2 border-b px-3 text-xs text-muted-foreground"
    >
      {mark}
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {view.pageStateLost && (
        <span className="shrink-0 text-subtle-foreground">
          Reopened after the browser was lost; sign-ins were reset
        </span>
      )}
      {privately && view.controller !== "human" ? (
        <button type="button" disabled={props.busy} onClick={props.onPrivate} className={action}>
          Take back privately
        </button>
      ) : (
        !stopped && (
          <>
            {view.controller !== "human" && (
              <Tip label="Sign in or handle something private: agents can't see the page meanwhile">
                <button
                  type="button"
                  disabled={props.busy}
                  onClick={props.onPrivate}
                  className={action}
                >
                  Take over privately
                </button>
              </Tip>
            )}
            <Tip label={keymap.takeControl.label} shortcut="takeControl">
              <button
                type="button"
                disabled={props.busy}
                onClick={props.onToggle}
                className={action}
              >
                {view.controller === "human" ? "Hand back" : "Take control"}
              </button>
            </Tip>
          </>
        )
      )}
    </div>
  );
}

export function useControl(source: PreviewSource, threadId: string, view: BrowserView | undefined) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = (title: string, task: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    task()
      .catch((error: unknown) =>
        toast.error({ title, description: error instanceof Error ? error.message : undefined }),
      )
      .finally(() => setBusy(false));
  };
  const toggle = () => {
    if (!view) return;
    const human = view.controller === "human";
    run(human ? "Couldn't hand back control" : "Couldn't take control", () =>
      human ? source.handback(threadId) : source.takeover(threadId),
    );
  };
  const takePrivately = () =>
    run("Couldn't take the page privately", () => source.takeover(threadId, "private"));
  return { busy, toggle, takePrivately };
}
