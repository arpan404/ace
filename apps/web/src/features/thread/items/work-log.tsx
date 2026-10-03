import { useItem } from "@ace/client-react";
import {
  BrainIcon,
  CaretRightIcon,
  EyeIcon,
  GlobeIcon,
  MagnifyingGlassIcon,
  NotePencilIcon,
  NoteIcon,
  TerminalIcon,
  WrenchIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { cn } from "cn";
import { useId, useState } from "react";
import { Spinner } from "@/components/ui/spinner.tsx";
import { formatDuration, useTicker } from "../lib/clock.ts";
import { describeStep, summarizeWork, workCounts, type StepIcon } from "../lib/describe-step.ts";
import { flatEqual, useItemsSelect } from "../lib/use-items.ts";
import { StepDetail } from "./step-detail.tsx";

const icons: Record<StepIcon, PhosphorIcon> = {
  read: EyeIcon,
  search: MagnifyingGlassIcon,
  shell: TerminalIcon,
  edit: NotePencilIcon,
  web: GlobeIcon,
  tool: WrenchIcon,
  think: BrainIcon,
  note: NoteIcon,
};

/**
 * "Worked for 4m 12s › Explored 6 files · Ran 3 commands · Edited 2 files". The whole tool log
 * at rest; expanding shows each step as a quiet row. Opens by itself when a step needs approval.
 */
export function WorkLog(props: { threadId: string; itemIds: readonly string[] }) {
  const summary = useItemsSelect(props.threadId, props.itemIds, summarizeWork, flatEqual);
  const [toggled, setOpen] = useState<boolean>();
  const open = toggled ?? summary?.awaiting ?? false;
  const now = useTicker(summary?.running ?? false);
  const panel = useId();
  if (!summary) return null;
  const elapsed = formatDuration(
    Math.max(1000, (summary.running ? now : summary.endedAt) - summary.startedAt),
  );
  const counts = workCounts(summary);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen(!open)}
        className="group -mx-1.5 inline-flex h-[26px] max-w-full items-center gap-1.5 rounded-[7px] px-1.5 text-[13.5px] text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
      >
        <span className={cn("shrink-0", summary.running && "shimmer")}>
          {summary.running ? `Working for ${elapsed}` : `Worked for ${elapsed}`}
        </span>
        <CaretRightIcon
          aria-hidden
          size={14}
          className={cn(
            "shrink-0 text-subtle-foreground transition-transform duration-200 ease-spring",
            open && "rotate-90",
          )}
        />
        {counts && <span className="ml-1 truncate text-sm text-subtle-foreground">{counts}</span>}
      </button>
      {summary.running && summary.current && !open && (
        <p className="mt-1 flex items-center gap-2 text-ui text-muted-foreground">
          <Spinner />
          <span className="truncate">{summary.current}</span>
        </p>
      )}
      {open && (
        <ul
          id={panel}
          aria-label="Steps"
          className="mt-0.5 mb-2 flex animate-in flex-col border-l-2 py-1 pl-2.5 duration-200 fade-in slide-in-from-top-1"
        >
          {props.itemIds.map((id) => (
            <ToolStep key={id} threadId={props.threadId} itemId={id} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** One row of the work log. Expands to its output, diff or reasoning. */
export function ToolStep(props: { threadId: string; itemId: string }) {
  const item = useItem(props.threadId, props.itemId);
  const awaiting = item?.type === "tool_call" && item.call.status === "awaiting_approval";
  const [open, setOpen] = useState(awaiting);
  const panel = useId();
  if (!item) return null;
  const step = describeStep(item);
  const Glyph = icons[step.icon];
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen(!open)}
        className="flex h-7 w-full min-w-0 items-center gap-2 rounded-sm px-1.5 text-left text-ui text-muted-foreground transition-colors duration-150 hover:bg-accent"
      >
        {step.settled ? (
          <Glyph aria-hidden size={14} className="shrink-0 text-subtle-foreground" />
        ) : (
          <Spinner className="mx-px" />
        )}
        <span className="shrink-0">{step.verb}</span>
        {step.target && (
          <code className="min-w-0 truncate font-mono text-[12px] text-foreground">
            {step.target}
          </code>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-3 text-xs text-subtle-foreground">
          {step.added !== undefined && (step.added > 0 || (step.removed ?? 0) > 0) && (
            <span className="font-mono">
              <span className="text-diff-add">+{step.added}</span>{" "}
              <span className="text-diff-del">−{step.removed ?? 0}</span>
            </span>
          )}
          {step.note && (
            <span className={cn(step.failed && "text-status-failed")}>{step.note}</span>
          )}
        </span>
      </button>
      {open && (
        <div id={panel} className="mt-1 mb-2 pl-6">
          <StepDetail item={item} />
        </div>
      )}
    </li>
  );
}
