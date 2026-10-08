import type { ReactNode } from "react";
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
    <div className="relative grid h-full min-h-0 place-items-center overflow-auto bg-background p-6">
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

/** The app mark (the "a" ring and stem of the app icon) and the name, 20px and 15/600. */
export function AceMark() {
  return (
    <p className="flex items-center gap-2 text-md font-semibold tracking-title">
      <svg
        aria-hidden
        viewBox="0 0 20 20"
        className="size-5 shrink-0 rounded-[6px] bg-foreground text-background"
      >
        <path
          fill="currentColor"
          fillRule="evenodd"
          d="M9.3 4.6a5.1 5.1 0 1 1 0 10.2a5.1 5.1 0 1 1 0 -10.2ZM9.3 6.4a3.3 3.3 0 1 0 0 6.6a3.3 3.3 0 1 0 0 -6.6Z"
        />
        <path fill="currentColor" d="M12.7 14.8V5.5a0.9 0.9 0 0 1 1.8 0V14.8Z" />
      </svg>
      ace
    </p>
  );
}
