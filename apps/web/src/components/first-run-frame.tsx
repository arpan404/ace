import type { ReactNode } from "react";
import { AceLogo } from "@/components/ace-logo.tsx";
import { useToastAnchor } from "@/lib/toast-clearance.ts";
import { part } from "@/lib/suit-part.ts";

/**
 * A first-run page (setup, connecting a machine): no app header, one 480px column high in the
 * window. The ace mark and the step on top, the title and its line, the step's content, then
 * its actions right under it, so the next move is never a screen away from what it acts on.
 */
export function FirstRunFrame(props: {
  page: string;
  variant?: string;
  /** "2 of 4", or a quiet way out, at the top's right. */
  corner?: ReactNode;
  title: string;
  lede?: ReactNode;
  children: ReactNode;
  /** The way out, at the actions' left (Skip for now). */
  aside?: ReactNode;
  /** The step's own buttons, at the right. */
  actions?: ReactNode;
}) {
  const pane = useToastAnchor();
  return (
    <main
      ref={pane}
      id="main"
      tabIndex={-1}
      data-part="page"
      data-page={props.page}
      data-variant={props.variant}
      className="relative min-h-0 flex-1 overflow-y-auto bg-background outline-none"
    >
      <div className="mx-auto flex min-h-full w-full max-w-[480px] flex-col px-6 pt-[12vh] pb-12">
        <div className="mb-12 flex h-8 items-center justify-between gap-4">
          <div className="flex items-center gap-2.5 text-lg font-semibold tracking-title">
            <AceLogo className="size-8" />
            ace
          </div>
          <div className="text-sm text-muted-foreground tabular-nums">{props.corner}</div>
        </div>
        <div key={props.variant} className="fx-view-in flex flex-col">
          <div {...part("page-header")}>
            <h1 {...part("page-title")} className="text-2xl font-semibold tracking-title">
              {props.title}
            </h1>
            {props.lede && (
              <p className="mt-2 text-base leading-normal text-muted-foreground">{props.lede}</p>
            )}
          </div>
          <div {...part("page-body")} className="mt-8">
            {props.children}
          </div>
        </div>
        {(props.aside || props.actions) && (
          <div {...part("page-toolbar")} className="mt-10 flex items-center justify-between gap-3">
            <div>{props.aside}</div>
            <div className="flex items-center gap-2">{props.actions}</div>
          </div>
        )}
      </div>
    </main>
  );
}
