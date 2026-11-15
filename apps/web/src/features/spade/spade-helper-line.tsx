import type { SpadeHelperStep } from "@ace/ui-core/spade-chat";
import { formatElapsed } from "@ace/ui-core/time";
import { useState } from "react";
import { Disclosure } from "@/components/ui/disclosure.tsx";
import { useSeconds } from "@/lib/time.ts";

type Steps =
  | { kind: "closed" }
  | { kind: "reading" }
  | { kind: "read"; steps: readonly SpadeHelperStep[] }
  | { kind: "failed" };

/** The line's shape, shared with a reply's steps line: one quiet line that opens. */
const lineClass = "h-7 rounded-full px-2 text-ui text-muted-foreground hover:bg-hover";

/**
 * A helper the bot started (ADR 0152): one quiet line in Spade's words ("Helper looking into: …",
 * "Helper found: …", "Helper stopped"), with how long it has been at it while it works, that
 * opens to the helper's own steps, read when it opens. Words only: no icon, no badge, no panel.
 */
export function SpadeHelperLine(props: {
  text: string;
  /** Still working: opening it reads its steps so far. */
  open: boolean;
  /** When it started, for its running time while it works; undefined when unknown. */
  since?: number | undefined;
  readSteps: (() => Promise<readonly SpadeHelperStep[]>) | undefined;
}) {
  const [steps, setSteps] = useState<Steps>({ kind: "closed" });
  const timed = props.open && props.since !== undefined;
  const now = useSeconds(timed);
  const read = props.readSteps;
  const toggle = (event: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (!event.currentTarget.open || !read) return setSteps({ kind: "closed" });
    setSteps({ kind: "reading" });
    read().then(
      (found) => setSteps({ kind: "read", steps: found }),
      () => setSteps({ kind: "failed" }),
    );
  };
  const line = (
    <>
      <span className="min-w-0 truncate">{props.text}</span>
      {timed && props.since !== undefined && (
        <span className="shrink-0 text-subtle-foreground tabular-nums">
          {formatElapsed(now - props.since)}
        </span>
      )}
    </>
  );
  if (!read)
    return (
      <p
        role="note"
        className="ml-1.5 flex h-7 min-w-0 items-center gap-1.5 px-2 text-ui text-muted-foreground"
      >
        {line}
      </p>
    );
  return (
    <div role="note" className="ml-1.5 min-w-0">
      <Disclosure
        summary={line}
        summaryClassName={lineClass}
        className="max-w-full"
        onToggle={toggle}
      >
        <div className="mt-1 mb-1 ml-3.5 flex flex-col gap-0.5 border-l border-border pl-3.5 text-ui text-muted-foreground">
          {steps.kind === "reading" && <p>Reading its steps…</p>}
          {steps.kind === "failed" && <p>Couldn't read its steps.</p>}
          {steps.kind === "read" && steps.steps.length === 0 && (
            <p>{props.open ? "Nothing yet." : "It took no steps."}</p>
          )}
          {steps.kind === "read" && steps.steps.length > 0 && (
            <ol aria-label="Its steps" className="flex flex-col gap-0.5">
              {steps.steps.map((step) => (
                <li
                  key={step.key}
                  className={
                    step.kind === "text"
                      ? "whitespace-pre-wrap text-foreground wrap-anywhere"
                      : "wrap-anywhere"
                  }
                >
                  {step.text}
                </li>
              ))}
            </ol>
          )}
        </div>
      </Disclosure>
    </div>
  );
}
