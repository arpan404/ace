import type { ReactNode } from "react";
import { AceLogo } from "@/components/ace-logo.tsx";
import { cn } from "@/lib/cn.ts";

/**
 * The frame every pre-app screen shares (connect, hand-off, boot failure, desktop failure):
 * a 50px strip the desktop window drags by and a compact form with the app mark.
 */
export function ConnectCard(props: {
  children: ReactNode;
  /** Wider cards hold diagnostics output. */
  wide?: boolean;
  /** `alertdialog`-style screens label the card by their heading. */
  labelledBy?: string;
}) {
  return (
    // Anchored from the top, not centred: a validation message or alert growing the form
    // extends it downwards instead of moving the heading the person is reading.
    <div className="relative flex h-full min-h-0 items-start justify-center overflow-auto bg-background p-6 pt-[18vh]">
      {/* The desktop window has no title bar; this strip moves it, as the shell's header does. */}
      <div aria-hidden className="fixed inset-x-0 top-0 z-[1] h-[50px] [-webkit-app-region:drag]" />
      <main
        {...(props.labelledBy ? { "aria-labelledby": props.labelledBy } : {})}
        className={cn("relative z-[2] w-full p-4", props.wide ? "max-w-[560px]" : "max-w-[420px]")}
      >
        <AceMark />
        {props.children}
      </main>
    </div>
  );
}

/** The app mark and the name, 20px and 15/600. */
function AceMark() {
  return (
    <p className="flex items-center gap-2 text-md font-semibold tracking-title">
      <AceLogo className="size-5" />
      ace
    </p>
  );
}
