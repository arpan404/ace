import { useItem } from "@ace/client-react";
import { checkLabels, checkOutcome, formatAgo, type CheckRun } from "@ace/ui-core";
import { cn } from "@/lib/cn.ts";
import { useNow } from "@/lib/time.ts";
import { capsule, CapsuleGlyph, CapsuleMeta, type CapsuleState } from "../agents/task-capsule.tsx";

const words = { passed: "Passed", failed: "Failed", running: "Running", ran: "Ran" } as const;
const glyphs: Record<keyof typeof words, CapsuleState> = {
  passed: "done",
  failed: "failed",
  running: "working",
  ran: "stopped",
};

/** The latest test, typecheck, lint and build runs of the turn: how each went, and when. */
export function Checks(props: { threadId: string; checks: readonly CheckRun[] }) {
  return (
    <ul>
      {props.checks.map((check) => (
        <CheckRow key={check.kind} threadId={props.threadId} check={check} />
      ))}
    </ul>
  );
}

/** One check; its step, when still loaded, says whether it runs and when it finished. */
function CheckRow(props: { threadId: string; check: CheckRun }) {
  const { check } = props;
  const item = useItem(props.threadId, check.itemId);
  const call = item?.type === "tool_call" ? item.call : undefined;
  const now = useNow();
  const outcome = checkOutcome(check, call?.status);
  const label = checkLabels[check.kind];
  const when = call?.endedAt ?? call?.startedAt;
  return (
    <li
      aria-label={`${label}: ${words[outcome]}`}
      className={cn("flex h-8 min-w-0 items-center gap-2 pr-2 pl-2 text-ui", capsule)}
    >
      <CapsuleGlyph state={glyphs[outcome]} />
      <span className="shrink-0 font-medium">{label}</span>
      <CapsuleMeta className="flex-1 font-mono text-subtle-foreground">
        <span title={check.command}>{check.command}</span>
      </CapsuleMeta>
      <span
        data-tone={outcome === "failed" ? "failed" : undefined}
        className={cn(
          "shrink-0 text-xs tabular-nums",
          outcome === "failed" ? "text-(--tone-text)" : "text-muted-foreground",
        )}
      >
        {words[outcome]}
        {outcome === "failed" && typeof check.exitCode === "number"
          ? ` · exit ${check.exitCode}`
          : ""}
        {outcome !== "running" && when !== undefined ? ` · ${formatAgo(when, now)}` : ""}
      </span>
    </li>
  );
}
