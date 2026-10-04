import type { DigestFact } from "@ace/ui-core";
import { cn } from "@/lib/cn.ts";

/**
 * A digest's facts on one line: "14 tools · 3 files +12 −4 · 1 failed". Colour only for the
 * diff counts and what failed or waits on the person (DESIGN principle 2).
 */
export function DigestFacts(props: { facts: readonly DigestFact[]; className?: string }) {
  if (!props.facts.length) return null;
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5 truncate", props.className)}>
      {props.facts.map((fact, index) => (
        <span key={fact.kind} className="flex shrink-0 items-center gap-1.5">
          {index > 0 && fact.kind !== "lines" && (
            <span aria-hidden className="text-subtle-foreground">
              ·
            </span>
          )}
          {fact.kind === "lines" ? (
            <span className="font-mono tabular-nums">
              <span className="text-status-done">+{fact.added?.toLocaleString("en-US")}</span>{" "}
              <span className="text-status-failed">−{fact.removed?.toLocaleString("en-US")}</span>
            </span>
          ) : (
            <span
              className={cn(
                fact.tone === "failed" && "text-status-failed",
                fact.tone === "needs-you" && "text-status-needs-you",
              )}
            >
              {fact.text}
            </span>
          )}
        </span>
      ))}
    </span>
  );
}
