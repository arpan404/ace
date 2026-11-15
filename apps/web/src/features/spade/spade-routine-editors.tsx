import type {
  SpadeAceEvent,
  SpadeHeartbeat,
  SpadeRoutine,
  SpadeTrigger,
} from "@ace/ui-core/spade-chat";
import { useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { Select } from "@/components/ui/select.tsx";
import { useCopy } from "@/components/use-copy.ts";
import { cn } from "@/lib/cn.ts";
import { fault } from "./spade-profile-actions.ts";
import { pillButton, rowPill } from "./spade-profile-parts.tsx";
import { addRoutine, editRoutine, removeRoutine, saveHeartbeat } from "./spade-routines-api.ts";
import { useSpadeClient } from "./spade-machine.tsx";

/*
 * A routine or the heartbeat opened where its row was, in the profile's width (docs/design/
 * spade.md §4): the kind of trigger is three words and only its fields follow. Esc puts it back.
 */

/** A field's label over or beside it, as a row of the routine's group. */
function Field(props: { label: string; htmlFor?: string; children: ReactNode; stacked?: boolean }) {
  return (
    <div
      className={cn(
        "flex gap-3 py-2.5",
        props.stacked ? "flex-col items-stretch gap-1.5" : "min-h-12 items-center",
      )}
    >
      <label htmlFor={props.htmlFor} className="min-w-0 flex-1 text-ui font-medium text-foreground">
        {props.label}
      </label>
      {props.children}
    </div>
  );
}

const well =
  "min-h-18 w-full resize-none rounded-md bg-chat-well px-3 py-2 text-ui leading-5 text-foreground shadow-[inset_0_0_0_1px_var(--border-strong)] outline-none [field-sizing:content] placeholder:text-subtle-foreground focus-visible:shadow-[inset_0_0_0_1px_var(--foreground)]";

type Kind = "schedule" | "event" | "webhook";

const kinds: { value: Kind; label: string }[] = [
  { value: "schedule", label: "Schedule" },
  { value: "event", label: "Thread event" },
  { value: "webhook", label: "Webhook" },
];

const events: { value: SpadeAceEvent; label: string }[] = [
  { value: "thread_done", label: "finishes" },
  { value: "thread_failed", label: "fails" },
  { value: "thread_needs_you", label: "needs you" },
];

function triggerOf(kind: Kind, schedule: string, event: SpadeAceEvent): SpadeTrigger {
  if (kind === "schedule") return { kind: "schedule", schedule: schedule.trim() };
  if (kind === "webhook") return { kind: "webhook" };
  return { kind: "event", event };
}

/** Esc anywhere in an editor puts it back, as long as it isn't saving. */
const escapes = (onCancel: () => void) => (event: React.KeyboardEvent) => {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  event.stopPropagation();
  onCancel();
};

/** Copy, saying Copied for a moment where it was pressed. */
function CopyButton(props: { text: string; label: string }) {
  const { copied, copy } = useCopy();
  return (
    <Button
      size="sm"
      variant="secondary"
      aria-label={props.label}
      className={rowPill}
      onClick={() => copy(props.text)}
    >
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

/**
 * A routine open for editing, or a new one: its name, the kind of trigger (a schedule in words or
 * cron, a thread event, or a webhook, whose address and secret show here once saved, with Copy),
 * and what the bot does each time. Delete, Cancel and Save at its foot. A new webhook routine stays
 * open once added, so its address can be copied.
 */
export function RoutineEditor(props: {
  agent: string;
  routine: SpadeRoutine | undefined;
  onDone(): void;
  onSaved(routine?: SpadeRoutine): void;
}) {
  const ids = { name: useId(), schedule: useId(), event: useId(), each: useId() };
  const client = useSpadeClient();
  const [routine, setRoutine] = useState(props.routine);
  const trigger = routine?.trigger;
  const [name, setName] = useState(routine?.name ?? "");
  const [instruction, setInstruction] = useState(routine?.instruction ?? "");
  const [kind, setKind] = useState<Kind>(trigger?.kind ?? "schedule");
  const [schedule, setSchedule] = useState(trigger?.kind === "schedule" ? trigger.schedule : "");
  const [event, setEvent] = useState<SpadeAceEvent>(
    trigger?.kind === "event" ? trigger.event : "thread_done",
  );
  const [saving, setSaving] = useState<"save" | "delete">();
  const [problem, setProblem] = useState<string>();
  const ready =
    name.trim() !== "" && instruction.trim() !== "" && (kind !== "schedule" || schedule.trim());
  const save = async () => {
    if (!ready) return;
    const draft = {
      name: name.trim(),
      instruction: instruction.trim(),
      trigger: triggerOf(kind, schedule, event),
    };
    setSaving("save");
    setProblem(undefined);
    try {
      if (!routine) {
        const added = await addRoutine(client, props.agent, draft);
        props.onSaved(added);
        if (added.webhook) setRoutine(added);
        else props.onDone();
        return;
      }
      const unchanged = JSON.stringify(routine.trigger) === JSON.stringify(draft.trigger);
      const saved = await editRoutine(client, routine.id, {
        name: draft.name,
        instruction: draft.instruction,
        ...(unchanged ? {} : { trigger: draft.trigger }),
      });
      props.onSaved(saved);
      // A routine turned into a webhook shows its new address before it closes.
      if (saved.webhook && !routine.webhook) setRoutine(saved);
      else props.onDone();
    } catch (error) {
      setProblem(fault(error));
    } finally {
      setSaving(undefined);
    }
  };
  const remove = async () => {
    if (!routine) return;
    setSaving("delete");
    setProblem(undefined);
    try {
      await removeRoutine(client, routine.id);
      props.onSaved();
      props.onDone();
    } catch (error) {
      setProblem(fault(error));
      setSaving(undefined);
    }
  };
  return (
    <form
      aria-label={routine ? `Edit ${routine.name}` : "New routine"}
      onKeyDown={escapes(props.onDone)}
      onSubmit={(submitted) => {
        submitted.preventDefault();
        void save();
      }}
      className="flex flex-col divide-y divide-border-soft"
    >
      <Field label="Name" htmlFor={ids.name}>
        <Input
          id={ids.name}
          value={name}
          autoFocus
          maxLength={60}
          placeholder="Morning brief"
          onChange={(change) => setName(change.target.value)}
          className="w-40"
        />
      </Field>
      <div className="py-2.5">
        <SegmentedControl
          label="When it runs"
          value={kind}
          options={kinds}
          onValueChange={(next) => setKind(next as Kind)}
          className="h-8 w-full [&>button]:h-7"
        />
      </div>
      {kind === "schedule" ? (
        <Field label="Every" htmlFor={ids.schedule}>
          <Input
            id={ids.schedule}
            value={schedule}
            placeholder="weekdays at 9:00"
            onChange={(change) => setSchedule(change.target.value)}
            className="w-40"
          />
        </Field>
      ) : kind === "event" ? (
        <Field label="When a thread" htmlFor={ids.event}>
          <Select
            id={ids.event}
            label="When a thread"
            value={event}
            options={events}
            onValueChange={(next) => setEvent(next as SpadeAceEvent)}
            className="w-40"
          />
        </Field>
      ) : (
        routine?.webhook && (
          <>
            <div className="flex min-h-12 items-center gap-3 py-2.5">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-ui font-medium text-foreground">Address</span>
                <span className="font-mono text-xs break-all text-subtle-foreground">
                  {`POST ${routine.webhook.path}`}
                </span>
              </div>
              <CopyButton text={routine.webhook.path} label="Copy the address" />
            </div>
            <div className="flex min-h-12 items-center gap-3 py-2.5">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-ui font-medium text-foreground">Secret</span>
                <span className="text-xs text-subtle-foreground">Sent as a bearer token</span>
              </div>
              <CopyButton text={routine.webhook.secret} label="Copy the secret" />
            </div>
          </>
        )
      )}
      <Field label="Each time" htmlFor={ids.each} stacked>
        <textarea
          id={ids.each}
          value={instruction}
          maxLength={4000}
          placeholder="What to do each time"
          onChange={(change) => setInstruction(change.target.value)}
          className={well}
        />
      </Field>
      <Foot
        problem={problem}
        remove={
          routine && (
            <Button
              variant="ghost"
              tone="danger"
              className={cn(pillButton, "-ml-3.5")}
              disabled={saving !== undefined}
              onClick={() => void remove()}
            >
              {saving === "delete" ? "Deleting…" : "Delete"}
            </Button>
          )
        }
        onCancel={props.onDone}
        save={
          <Button
            type="submit"
            variant="primary"
            className={pillButton}
            disabled={!ready || saving !== undefined}
          >
            {saving === "save" ? "Saving…" : routine ? "Save" : "Add routine"}
          </Button>
        }
      />
    </form>
  );
}

/** An editor's foot: what went wrong, then Delete on the left, Cancel and the save on the right. */
function Foot(props: {
  problem: string | undefined;
  remove?: ReactNode;
  onCancel(): void;
  save: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 py-3">
      {props.problem && (
        <p role="alert" className="text-xs text-destructive">
          {props.problem}
        </p>
      )}
      <div className="flex items-center gap-1">
        {props.remove}
        <Button variant="ghost" className={cn(pillButton, "ml-auto")} onClick={props.onCancel}>
          Cancel
        </Button>
        {props.save}
      </div>
    </div>
  );
}

const intervals = [15, 30, 60, 120, 240].map((minutes) => ({
  value: String(minutes),
  label:
    minutes < 60
      ? `Every ${minutes} minutes`
      : minutes === 60
        ? "Every hour"
        : `Every ${minutes / 60} hours`,
}));

/**
 * The heartbeat open where its row was: how often, a checklist the bot goes through, saying
 * something only when it needs the person, and quiet hours, when it doesn't check. Saving turns
 * it on.
 */
export function HeartbeatEditor(props: {
  agent: string;
  heartbeat: SpadeHeartbeat;
  onDone(): void;
  onSaved(): void;
}) {
  const ids = { checklist: useId(), every: useId() };
  const client = useSpadeClient();
  const [checklist, setChecklist] = useState(props.heartbeat.checklist);
  const [everyMinutes, setEvery] = useState(String(props.heartbeat.everyMinutes));
  const [start, setStart] = useState(props.heartbeat.quiet?.start ?? "");
  const [end, setEnd] = useState(props.heartbeat.quiet?.end ?? "");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();
  const options = intervals.some((option) => option.value === everyMinutes)
    ? intervals
    : [...intervals, { value: everyMinutes, label: `Every ${everyMinutes} minutes` }];
  const ready = checklist.trim() !== "" && (start === "") === (end === "");
  const save = async () => {
    if (!ready) return;
    setSaving(true);
    setProblem(undefined);
    try {
      await saveHeartbeat(client, props.agent, {
        enabled: true,
        checklist: checklist.trim(),
        every_minutes: Number(everyMinutes),
        quiet: start && end ? { start, end } : null,
      });
      props.onSaved();
      props.onDone();
    } catch (error) {
      setProblem(fault(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      aria-label="Edit heartbeat"
      onKeyDown={escapes(props.onDone)}
      onSubmit={(submitted) => {
        submitted.preventDefault();
        void save();
      }}
      className="flex flex-col divide-y divide-border-soft"
    >
      <Field label="Heartbeat" htmlFor={ids.every}>
        <Select
          id={ids.every}
          label="How often"
          value={everyMinutes}
          options={options}
          onValueChange={setEvery}
          className="w-40"
        />
      </Field>
      <Field label="Checklist" htmlFor={ids.checklist} stacked>
        <textarea
          id={ids.checklist}
          value={checklist}
          autoFocus
          maxLength={4000}
          placeholder="Is the build green? Any review waiting on me?"
          onChange={(change) => setChecklist(change.target.value)}
          className={well}
        />
      </Field>
      <div className="flex min-h-12 items-center gap-2 py-2.5 text-ui">
        <span className="min-w-0 flex-1 font-medium text-foreground">Quiet hours</span>
        <Input
          type="time"
          aria-label="Quiet from"
          value={start}
          onChange={(change) => setStart(change.target.value)}
          className="w-28"
        />
        <span className="text-subtle-foreground">to</span>
        <Input
          type="time"
          aria-label="Quiet until"
          value={end}
          onChange={(change) => setEnd(change.target.value)}
          className="w-28"
        />
      </div>
      <Foot
        problem={problem}
        onCancel={props.onDone}
        save={
          <Button
            type="submit"
            variant="primary"
            className={pillButton}
            disabled={!ready || saving}
          >
            {saving ? "Saving…" : props.heartbeat.enabled ? "Save" : "Turn on"}
          </Button>
        }
      />
    </form>
  );
}
