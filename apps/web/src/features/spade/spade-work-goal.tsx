import {
  spadeCriteriaMarks,
  spadeGoalHeading,
  spadePlanRows,
  type SpadeEvidence,
  type SpadePlanMark,
  type SpadeTask,
} from "@ace/ui-core/spade-chat";
import {
  CheckCircleIcon,
  CircleDashedIcon,
  CircleIcon,
  HandIcon,
  PlusIcon,
  XIcon,
} from "@ace/icons";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Icon, type IconGlyph } from "@/components/icon.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { cn } from "@/lib/cn.ts";
import { ProfileSection } from "./spade-profile-parts.tsx";
import { useSpadeClient } from "./spade-machine.tsx";
import { setGoal } from "./spade-work-api.ts";
import { workKey } from "./use-spade-work.ts";
import type { RosterBot } from "./use-spade-roster.ts";

/*
 * The goal in the person's words with its criteria and the check's verdict on each, then the plan
 * with each item's mark and evidence (ADR 0159). The title and each criterion edit where they
 * are: click, type, ↵ saves, Esc puts it back. Only the person changes the goal.
 */

const marks: Record<
  SpadePlanMark,
  { icon: IconGlyph; fill: boolean; tone: string; label: string }
> = {
  verified: { icon: CheckCircleIcon, fill: true, tone: "text-status-done", label: "Verified" },
  claimed: {
    icon: CheckCircleIcon,
    fill: false,
    tone: "text-muted-foreground",
    label: "Done, not checked",
  },
  working: {
    icon: CircleDashedIcon,
    fill: false,
    tone: "text-muted-foreground",
    label: "In progress",
  },
  waiting: { icon: HandIcon, fill: false, tone: "text-status-needs-you", label: "Waits on you" },
  open: { icon: CircleIcon, fill: false, tone: "text-subtle-foreground", label: "Not started" },
};

function Mark(props: { mark: SpadePlanMark; label?: string }) {
  const mark = marks[props.mark];
  return (
    <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
      <Icon
        icon={mark.icon}
        size={16}
        weight={mark.fill ? "fill" : "regular"}
        label={props.label ?? mark.label}
        className={mark.tone}
      />
    </span>
  );
}

/** Saves a changed goal; resolves with Spade's refusal in words, or undefined once saved. */
function useSaveGoal(bot: RosterBot, task: SpadeTask) {
  const client = useSpadeClient();
  const cache = useQueryClient();
  return async (change: { title?: string; criteria?: readonly string[] }) => {
    try {
      await setGoal(client, bot.id, {
        title: change.title ?? task.goal.title,
        criteria: change.criteria ?? task.goal.criteria.map((criterion) => criterion.text),
        text: task.goal.text,
      });
      await cache.invalidateQueries({ queryKey: workKey(bot) });
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : "Spade didn't take the change.";
    }
  };
}

/**
 * Words that turn into their field in place: ↵ or leaving it saves, Esc puts them back. An empty
 * field saves nothing.
 */
function InPlace(props: {
  value: string;
  label: string;
  placeholder?: string;
  /** Starts as the field (a new criterion). */
  editing?: boolean;
  className?: string;
  save(text: string): Promise<string | undefined>;
  onDone?(): void;
  children: React.ReactNode;
}) {
  const [editing, setEditing] = useState(props.editing ?? false);
  const [text, setText] = useState(props.value);
  const [problem, setProblem] = useState<string>();
  const [saving, setSaving] = useState(false);
  const dropped = useRef(false);
  const finish = () => {
    setEditing(false);
    props.onDone?.();
  };
  const save = async () => {
    if (dropped.current) return;
    const next = text.trim();
    if (!next || next === props.value.trim()) return finish();
    setSaving(true);
    const refused = await props.save(next);
    setSaving(false);
    setProblem(refused);
    if (!refused) finish();
  };
  if (!editing)
    return (
      <button
        type="button"
        aria-label={`Edit ${props.label}: ${props.value}`}
        onClick={() => {
          dropped.current = false;
          setText(props.value);
          setProblem(undefined);
          setEditing(true);
        }}
        className={cn(
          "-mx-1.5 min-w-0 flex-1 rounded-md px-1.5 text-left focus-ring-inset hover:bg-hover",
          props.className,
        )}
      >
        {props.children}
      </button>
    );
  return (
    <div className="-mx-1.5 flex min-w-0 flex-1 flex-col gap-1">
      <input
        aria-label={props.label}
        value={text}
        autoFocus
        disabled={saving}
        placeholder={props.placeholder}
        aria-invalid={problem ? true : undefined}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => void save()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void save();
          } else if (event.key === "Escape") {
            event.stopPropagation();
            dropped.current = true;
            setProblem(undefined);
            finish();
          }
        }}
        className={cn(
          "min-w-0 rounded-md bg-chat-well px-1.5 text-foreground shadow-[inset_0_0_0_1px_var(--foreground)] outline-none placeholder:text-subtle-foreground",
          props.className,
        )}
      />
      {problem && (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}

/** The goal: its title and the person's words, each criterion with the check's verdict. */
export function WorkGoal(props: { bot: RosterBot; task: SpadeTask }) {
  const { bot, task } = props;
  const save = useSaveGoal(bot, task);
  const [adding, setAdding] = useState(false);
  const { criteria, note } = spadeCriteriaMarks(task);
  const texts = task.goal.criteria.map((criterion) => criterion.text);
  const heading = spadeGoalHeading(task.progress);
  const open = task.goal.closed === undefined;
  return (
    <ProfileSection
      label="Goal"
      actions={
        heading && (
          <span
            className={cn(
              "text-ui",
              task.progress.state === "done" ? "text-status-done" : "text-foreground",
            )}
          >
            {heading}
          </span>
        )
      }
    >
      <div className="flex flex-col gap-0.5 py-3">
        {open ? (
          <InPlace
            value={task.goal.title}
            label="the goal"
            className="py-0.5 text-md leading-[22px] font-medium"
            save={(title) => save({ title })}
          >
            {task.goal.title}
          </InPlace>
        ) : (
          <p className="text-md leading-[22px] font-medium text-foreground">{task.goal.title}</p>
        )}
        {task.goal.text && (
          <p className="text-ui leading-5 text-muted-foreground">“{task.goal.text}”</p>
        )}
      </div>
      {criteria.map((criterion, index) => (
        <div key={`${criterion.id}:${criterion.text}`} className="group/row flex gap-2.5 py-2.5">
          <Mark
            mark={criterion.met ? "verified" : "open"}
            label={criterion.met ? "Met" : "Not met yet"}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            {open ? (
              <InPlace
                value={criterion.text}
                label="the criterion"
                className="text-ui leading-5 text-foreground"
                save={(text) => save({ criteria: texts.with(index, text) })}
              >
                {criterion.text}
              </InPlace>
            ) : (
              <p className="text-ui leading-5 text-foreground">{criterion.text}</p>
            )}
            {criterion.why && (
              <p className="text-xs leading-4 text-muted-foreground">{criterion.why}</p>
            )}
          </div>
          {open && texts.length > 1 && (
            <RemoveCriterion
              text={criterion.text}
              onRemove={() => save({ criteria: texts.toSpliced(index, 1) })}
            />
          )}
        </div>
      ))}
      {note && <p className="py-2.5 text-xs leading-4 text-muted-foreground">{note}</p>}
      {open &&
        (adding ? (
          <div className="flex gap-2.5 py-2.5">
            <Mark mark="open" label="Not met yet" />
            <InPlace
              value=""
              label="New criterion"
              placeholder="What must hold for it to be done"
              editing
              className="text-ui leading-5"
              save={(text) => save({ criteria: [...texts, text] })}
              onDone={() => setAdding(false)}
            >
              {""}
            </InPlace>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="-mx-4 flex min-h-(--setting-row-height-single) items-center gap-2.5 px-4 text-left text-ui text-muted-foreground focus-ring-inset hover:text-foreground"
          >
            <Icon icon={PlusIcon} size={16} />
            Add a criterion
          </button>
        ))}
    </ProfileSection>
  );
}

function RemoveCriterion(props: { text: string; onRemove(): Promise<string | undefined> }) {
  const toast = useToast();
  return (
    <button
      type="button"
      aria-label={`Remove ${props.text}`}
      onClick={() =>
        void props.onRemove().then((refused) => {
          if (refused)
            toast.error({ title: "Couldn't remove the criterion", description: refused });
        })
      }
      className="-mr-1 grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground opacity-0 transition-opacity duration-(--motion-fast) group-hover/row:opacity-100 focus-ring hover:bg-hover hover:text-foreground focus-visible:opacity-100"
    >
      <Icon icon={XIcon} size={14} />
    </button>
  );
}

/** The plan: each item under its parent with its mark, its evidence and its one note. */
export function WorkPlan(props: {
  task: SpadeTask;
  evidenceWords(evidence: SpadeEvidence): string;
  onEvidence(evidence: SpadeEvidence): void;
}) {
  const rows = spadePlanRows(props.task.items);
  if (!rows.length) return null;
  return (
    <ProfileSection label="Plan">
      {rows.map((row) => (
        <div
          key={row.item.id}
          className="flex gap-2.5 py-2.5"
          style={{ paddingLeft: `calc(${row.depth} * var(--spacing) * 6)` }}
        >
          <Mark mark={row.mark} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="text-ui leading-5 text-foreground">{row.item.text}</p>
            {row.note && (
              <p
                className={cn(
                  "text-xs leading-4",
                  row.note.tone === "waiting" ? "text-status-needs-you" : "text-muted-foreground",
                )}
              >
                {row.note.tone === "not-yet" && (
                  <span className="font-medium text-foreground">Not yet: </span>
                )}
                {row.note.text}
              </p>
            )}
            {row.item.evidence.map((evidence) => (
              <button
                key={JSON.stringify(evidence)}
                type="button"
                onClick={() => props.onEvidence(evidence)}
                className="w-fit max-w-full truncate rounded-xs text-left font-mono text-xs leading-4 text-muted-foreground underline decoration-border underline-offset-2 focus-ring hover:text-foreground hover:decoration-current"
              >
                {props.evidenceWords(evidence)}
              </button>
            ))}
          </div>
        </div>
      ))}
    </ProfileSection>
  );
}
