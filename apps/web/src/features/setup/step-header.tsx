import type { ReactNode } from "react";
import { part } from "@/lib/suit-part.ts";

/** A step's mark, its name as the page's heading, and at most one short line under it. */
export function StepHeader(props: { mark: ReactNode; title: string; lede?: ReactNode }) {
  return (
    <div {...part("page-header")} className="flex flex-col items-center gap-3 text-center">
      <div className="mb-2 grid size-12 shrink-0 place-items-center">{props.mark}</div>
      <h2 {...part("page-title")} className="text-2xl font-semibold tracking-title">
        {props.title}
      </h2>
      {props.lede && (
        <p className="max-w-[44ch] text-base leading-normal text-muted-foreground">{props.lede}</p>
      )}
    </div>
  );
}
