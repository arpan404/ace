import type { SpadeHelperStep } from "@ace/ui-core/spade-chat";
import { useState } from "react";
import { Disclosure } from "@/components/ui/disclosure.tsx";

type Steps =
  | { kind: "closed" }
  | { kind: "reading" }
  | { kind: "read"; steps: readonly SpadeHelperStep[] }
  | { kind: "failed" };

/**
 * A helper the bot started (ADR 0152): one quiet line in Spade's words ("Helper looking into: …",
 * "Helper found: …", "Helper stopped") that expands to the helper's own steps, read when it
 * opens. Words only: no icon, no badge, no panel.
 */
export function SpadeHelperLine(props: {
  text: string;
  /** Still working: opening it reads its steps so far. */
  open: boolean;
  readSteps: (() => Promise<readonly SpadeHelperStep[]>) | undefined;
}) {
  const [steps, setSteps] = useState<Steps>({ kind: "closed" });
  const read = props.readSteps;
  const toggle = (event: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (!event.currentTarget.open || !read) return setSteps({ kind: "closed" });
    setSteps({ kind: "reading" });
    read().then(
      (found) => setSteps({ kind: "read", steps: found }),
      () => setSteps({ kind: "failed" }),
    );
  };
  if (!read)
    return (
      <p role="note" className="max-w-[80%] pl-9.5 text-xs text-muted-foreground wrap-anywhere">
        {props.text}
      </p>
    );
  return (
    <div role="note" className="pl-9.5">
      <Disclosure
        summary={<span className="wrap-anywhere">{props.text}</span>}
        summaryClassName="text-xs"
        className="max-w-[80%]"
        onToggle={toggle}
      >
        <div className="mt-1 flex flex-col gap-1 pl-4.5 text-xs text-muted-foreground">
          {steps.kind === "reading" && <p>Reading its steps…</p>}
          {steps.kind === "failed" && <p>Couldn't read its steps.</p>}
          {steps.kind === "read" && steps.steps.length === 0 && (
            <p>{props.open ? "Nothing yet." : "It took no steps."}</p>
          )}
          {steps.kind === "read" && steps.steps.length > 0 && (
            <ol aria-label="Its steps" className="flex flex-col gap-1">
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
