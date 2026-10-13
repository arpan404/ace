import type { ReactNode, TransitionEventHandler } from "react";
import { AceLogo } from "@/components/ace-logo.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";

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
  const ended: TransitionEventHandler<HTMLDivElement> = (event) => {
    if (event.target === event.currentTarget && props.leaving) props.onLeft?.();
  };
  return (
    <div
      data-slot="startup-screen"
      data-leaving={props.leaving ? "" : undefined}
      aria-busy={props.busy}
      onTransitionEnd={ended}
      className="fixed inset-0 z-[141] bg-background text-foreground transition-opacity duration-(--motion-slow) ease-(--ease-out) data-leaving:pointer-events-none data-leaving:opacity-0"
    >
      {/* The window has no title bar; the top strip moves it, as the shell's header does. */}
      <div aria-hidden className="fixed inset-x-0 top-0 h-[50px] [-webkit-app-region:drag]" />
      <AceLogo className="absolute top-1/2 left-1/2 size-11 -translate-x-1/2 -translate-y-1/2" />
      <div className="absolute inset-x-0 top-[calc(50%+44px)] flex flex-col items-center gap-4 px-6 text-center">
        {props.children}
      </div>
    </div>
  );
}

/** The one status line under the mark: a quiet spinner (none under reduced motion) and words. */
export function StartupStatus(props: { message?: string | undefined }) {
  return (
    <p
      role="status"
      aria-live="polite"
      className="flex h-5 items-center gap-2 text-sm text-muted-foreground"
    >
      {props.message && (
        <span className="fx-view-in flex items-center gap-2">
          <Spinner className="text-muted-foreground [:root[data-reduce-motion]_&]:hidden" />
          {props.message}
        </span>
      )}
    </p>
  );
}
