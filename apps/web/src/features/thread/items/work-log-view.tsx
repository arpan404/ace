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
import type { StepIcon, StepText, WorkLogHeadline } from "@ace/ui-core";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";

/* Pure views of a work log; `work-log.tsx` binds them to the live thread. */

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

/** "Worked for 4m 12s ›  Explored 6 files · Ran 3 commands", and the live step while closed. */
export function WorkLogHeader(props: {
  headline: WorkLogHeadline;
  open: boolean;
  panel: string;
  onToggle(): void;
}) {
  const { headline, open } = props;
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={props.panel}
        onClick={props.onToggle}
        className="group -mx-1.5 inline-flex h-[26px] max-w-full items-center gap-1.5 rounded-sm px-1.5 text-[13.5px] text-muted-foreground transition-colors duration-(--dur-1) hover:bg-accent hover:text-foreground"
      >
        <span className={headline.running ? "shrink-0 shimmer" : "shrink-0"}>{headline.label}</span>
        <CaretRightIcon
          aria-hidden
          size={14}
          className={cn(
            "shrink-0 text-subtle-foreground transition-transform duration-(--dur-2) ease-spring",
            open && "rotate-90",
          )}
        />
        {headline.counts && (
          <span className="ml-1 truncate text-sm text-subtle-foreground">{headline.counts}</span>
        )}
      </button>
      {headline.current && !open && (
        <p className="mt-1 flex items-center gap-2 text-ui text-muted-foreground">
          <Spinner />
          <span className="truncate">{headline.current}</span>
        </p>
      )}
    </>
  );
}

/** One quiet step row: glyph or spinner, verb, target, diff stat and note. */
export function StepRow(props: { step: StepText; open: boolean; panel: string; onToggle(): void }) {
  const { step } = props;
  const Glyph = icons[step.icon];
  return (
    <button
      type="button"
      aria-expanded={props.open}
      aria-controls={props.panel}
      aria-label={[step.verb, step.target, step.note].filter(Boolean).join(" ")}
      onClick={props.onToggle}
      className="flex h-7 w-full min-w-0 items-center gap-2 rounded-sm px-1.5 text-left text-ui text-muted-foreground transition-colors duration-(--dur-1) hover:bg-accent"
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
            <span className="text-status-done">+{step.added}</span>{" "}
            <span className="text-status-failed">−{step.removed ?? 0}</span>
          </span>
        )}
        {step.note && <span className={cn(step.failed && "text-status-failed")}>{step.note}</span>}
      </span>
    </button>
  );
}
