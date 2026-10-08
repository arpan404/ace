import type { MergedForkContext } from "@ace/protocol";
import { useState } from "react";
import { ThreadLink } from "./thread-link.tsx";

export function MergedForkNotice(props: { context: MergedForkContext }) {
  const [open, setOpen] = useState(false);
  return (
    <div role="note" className="text-ui text-muted-foreground">
      <div className="flex min-h-8 flex-wrap items-center gap-1">
        <span>
          Merged from{" "}
          <ThreadLink threadId={props.context.sourceThreadId} fallback="forked thread" />
        </span>
        {props.context.patchApplied && <span>· Code changes included</span>}
        <button
          type="button"
          className="ml-auto text-xs hover:text-foreground"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? "Hide summary" : "Show summary"}
        </button>
      </div>
      {open && <p className="whitespace-pre-wrap">{props.context.summary}</p>}
    </div>
  );
}
