import { useLayoutEffect, useRef, type ReactNode, type TransitionEventHandler } from "react";
import { AceLogo } from "@/components/ace-logo.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";

/**
 * The startup screen's frame: the ace mark centred on the theme's background, exactly where
 * `index.html` draws it before any script runs, and one slot under it that never moves the mark.
 */
export function StartupLayout(props: {
  leaving?: boolean;
  busy?: boolean;
  onLeft?: () => void;
  children?: ReactNode;
}) {
  const frame = useRef<HTMLDivElement>(null);
  // The mark breathes while ace starts. It carries on the first paint's breath (same start on
  // the document timeline) instead of restarting it, so the handover from index.html is unseen.
  useLayoutEffect(() => {
    const first = document.querySelector("#boot .mark")?.getAnimations?.()[0];
    const own = frame.current?.querySelector("svg")?.getAnimations?.()[0];
    if (own && first?.startTime != null) own.startTime = first.startTime;
  }, []);
  const ended: TransitionEventHandler<HTMLDivElement> = (event) => {
    if (event.target === event.currentTarget && props.leaving) props.onLeft?.();
  };
  return (
    <div
      ref={frame}
      data-slot="startup-screen"
      data-leaving={props.leaving ? "" : undefined}
      aria-busy={props.busy}
      onTransitionEnd={ended}
      className="fixed inset-0 z-[141] bg-background text-foreground transition-opacity duration-(--motion-slow) ease-(--ease-out) data-leaving:pointer-events-none data-leaving:opacity-0"
    >
      {/* The window has no title bar; the top strip moves it, as the shell's header does. */}
      <div aria-hidden className="fixed inset-x-0 top-0 h-[50px] [-webkit-app-region:drag]" />
      {/* Leaving, only the plain background fades: the app is already drawn underneath, and a
          mark or status line fading out over a transcript reads as a glitch. */}
      {!props.leaving && (
        <>
          <AceLogo
            className={cn(
              "absolute top-1/2 left-1/2 size-11 -translate-x-1/2 -translate-y-1/2",
              props.busy && "fx-breathe",
            )}
          />
          <div className="absolute inset-x-0 top-[calc(50%+44px)] flex flex-col items-center gap-4 px-6 text-center">
            {props.children}
          </div>
        </>
      )}
    </div>
  );
}

/** The one status line under the mark: a quiet spinner and words. */
export function StartupStatus(props: { message?: string | undefined }) {
  return (
    <p
      role="status"
      aria-live="polite"
      className="flex h-5 items-center gap-2 text-sm text-muted-foreground"
    >
      {props.message && (
        <span className="fx-view-in flex items-center gap-2">
          <Spinner className="text-muted-foreground" />
          {props.message}
        </span>
      )}
    </p>
  );
}
