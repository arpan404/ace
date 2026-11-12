import type { SpadeHeartbeat, SpadeRoutine, SpadeTrigger } from "@ace/ui-core/spade-chat";
import { useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input, Textarea } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { addRoutine, editRoutine, removeRoutine, saveHeartbeat } from "./spade-routines-api.ts";
import { useSpadeClient } from "./spade-machine.tsx";

function Field(props: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={props.htmlFor} className="w-fit text-ui font-medium">
        {props.label}
      </label>
      {props.children}
    </div>
  );
}

const fault = (error: unknown) => (error instanceof Error ? error.message : "Try again.");

type When = "schedule" | "thread_done" | "thread_failed" | "thread_needs_you" | "webhook";

const whenOptions: { value: When; label: string }[] = [
  { value: "schedule", label: "On a schedule" },
  { value: "thread_done", label: "When an agent thread finishes" },
  { value: "thread_failed", label: "When an agent thread fails" },
  { value: "thread_needs_you", label: "When an agent thread needs you" },
  { value: "webhook", label: "When its webhook is called" },
];

function whenOf(trigger: SpadeTrigger | undefined): When {
  if (!trigger || trigger.kind === "schedule") return "schedule";
  return trigger.kind === "webhook" ? "webhook" : trigger.event;
}

function triggerOf(when: When, schedule: string): SpadeTrigger {
  if (when === "schedule") return { kind: "schedule", schedule: schedule.trim() };
  if (when === "webhook") return { kind: "webhook" };
  return { kind: "event", event: when };
}

/**
 * Add or edit a routine: its name, what the bot does each time, and when. A schedule is written
 * in words (`weekdays at 9:00`) or cron; Spade says what it couldn't read. A webhook routine shows
 * its address and secret once saved. Editing also deletes.
 */
export function RoutineDialog(props: {
  agent: string;
  routine: SpadeRoutine | undefined;
  onClose(): void;
  onSaved(): void;
}) {
  const { routine } = props;
  const ids = { name: useId(), instruction: useId(), when: useId(), schedule: useId() };
  const client = useSpadeClient();
  const [name, setName] = useState(routine?.name ?? "");
  const [instruction, setInstruction] = useState(routine?.instruction ?? "");
  const [when, setWhen] = useState<When>(whenOf(routine?.trigger));
  const [schedule, setSchedule] = useState(
    routine?.trigger?.kind === "schedule" ? routine.trigger.schedule : "",
  );
  const [saving, setSaving] = useState<"save" | "delete">();
  const [problem, setProblem] = useState<string>();
  const ready =
    name.trim() !== "" && instruction.trim() !== "" && (when !== "schedule" || schedule.trim());
  const run = async (what: "save" | "delete", work: () => Promise<unknown>) => {
    setSaving(what);
    setProblem(undefined);
    try {
      await work();
      props.onSaved();
      props.onClose();
    } catch (error) {
      setProblem(fault(error));
    } finally {
      setSaving(undefined);
    }
  };
  const save = () => {
    const draft = {
      name: name.trim(),
      instruction: instruction.trim(),
      trigger: triggerOf(when, schedule),
    };
    if (!routine) return run("save", () => addRoutine(client, props.agent, draft));
    const unchanged =
      routine.trigger !== undefined &&
      JSON.stringify(routine.trigger) === JSON.stringify(draft.trigger);
    return run("save", () =>
      editRoutine(client, routine.id, {
        name: draft.name,
        instruction: draft.instruction,
        ...(unchanged ? {} : { trigger: draft.trigger }),
      }),
    );
  };
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{routine ? "Edit routine" : "New routine"}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <Field label="Name" htmlFor={ids.name}>
            <Input
              id={ids.name}
              value={name}
              maxLength={60}
              placeholder="Daily briefing"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="Instruction" htmlFor={ids.instruction}>
            <Textarea
              id={ids.instruction}
              value={instruction}
              maxLength={4000}
              placeholder="What to do each time"
              onChange={(event) => setInstruction(event.target.value)}
            />
          </Field>
          <Field label="When" htmlFor={ids.when}>
            <Select
              id={ids.when}
              label="When"
              value={when}
              options={whenOptions}
              onValueChange={(next) => setWhen(next as When)}
              className="w-72"
            />
          </Field>
          {when === "schedule" && (
            <Field label="Schedule" htmlFor={ids.schedule}>
              <Input
                id={ids.schedule}
                value={schedule}
                placeholder="weekdays at 9:00"
                onChange={(event) => setSchedule(event.target.value)}
              />
            </Field>
          )}
          {when === "webhook" && routine?.webhook && (
            <Field label="Webhook">
              <p className="font-mono text-xs break-all text-muted-foreground select-all">
                {`POST ${routine.webhook.path}`}
              </p>
              <p className="font-mono text-xs break-all text-muted-foreground select-all">
                {`Authorization: Bearer ${routine.webhook.secret}`}
              </p>
            </Field>
          )}
          {problem && (
            <p role="alert" className="text-ui text-destructive">
              {problem}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          {routine && (
            <Button
              variant="ghost"
              tone="danger"
              className="mr-auto"
              disabled={saving !== undefined}
              onClick={() => void run("delete", () => removeRoutine(client, routine.id))}
            >
              {saving === "delete" ? "Deleting…" : "Delete routine"}
            </Button>
          )}
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!ready || saving !== undefined}
            onClick={() => void save()}
          >
            {saving === "save" ? "Saving…" : routine ? "Save" : "Add routine"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
 * The heartbeat: a checklist the bot goes through every so often, saying something only when it
 * needs the person; how often; and quiet hours, when it doesn't check. Saving turns it on.
 */
export function HeartbeatDialog(props: {
  agent: string;
  heartbeat: SpadeHeartbeat;
  onClose(): void;
  onSaved(): void;
}) {
  const ids = { checklist: useId(), every: useId(), start: useId(), end: useId() };
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
  const quietReady = (start === "") === (end === "");
  const save = async () => {
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
      props.onClose();
    } catch (error) {
      setProblem(fault(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Heartbeat</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <Field label="Checklist" htmlFor={ids.checklist}>
            <Textarea
              id={ids.checklist}
              value={checklist}
              maxLength={4000}
              placeholder="Is the build green? Any review waiting on me?"
              onChange={(event) => setChecklist(event.target.value)}
            />
          </Field>
          <Field label="How often" htmlFor={ids.every}>
            <Select
              id={ids.every}
              label="How often"
              value={everyMinutes}
              options={options}
              onValueChange={setEvery}
              className="w-56"
            />
          </Field>
          <Field label="Quiet hours">
            <div className="flex items-center gap-2 text-ui">
              <Input
                id={ids.start}
                type="time"
                aria-label="Quiet from"
                value={start}
                onChange={(event) => setStart(event.target.value)}
                className="w-32"
              />
              <span className="text-muted-foreground">to</span>
              <Input
                id={ids.end}
                type="time"
                aria-label="Quiet until"
                value={end}
                onChange={(event) => setEnd(event.target.value)}
                className="w-32"
              />
            </div>
          </Field>
          {problem && (
            <p role="alert" className="text-ui text-destructive">
              {problem}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!checklist.trim() || !quietReady || saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
