import { updateChoices } from "@ace/ui-core";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import type { FleetUpdate } from "./data/use-fleet-update.ts";

type When = "idle" | "now";
const whenOptions = [
  { value: "idle" as const, label: "When idle" },
  { value: "now" as const, label: "Now" },
];
const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/**
 * Choose which machines to update: every one that can, ticked to start with, each with the
 * release it gets and what's in the way (agents at work, offline). When idle, each updates once
 * nothing works there; Now restarts them at once and says which agents that stops.
 */
export function FleetUpdatePicker(props: { update: FleetUpdate; onClose(): void }) {
  const { update } = props;
  const choices = updateChoices(update.plan);
  const [picked, setPicked] = useState(() => new Set(choices.map((choice) => choice.id)));
  const [when, setWhen] = useState<When>("idle");
  const listId = useId();
  const shown = when === "now" ? choices.filter((choice) => !choice.offline) : choices;
  const chosen = shown.filter((choice) => picked.has(choice.id));
  const busy = chosen.filter((choice) => choice.busy > 0);
  const agents = busy.reduce((sum, choice) => sum + choice.busy, 0);
  const from = (id: string) =>
    update.machines.find((machine) => machine.id === id)?.update?.version;
  const all = shown.length > 0 && chosen.length === shown.length;
  const toggle = (id: string, on: boolean) =>
    setPicked((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update machines</DialogTitle>
          <DialogDescription>
            Pick the machines to update. This computer updates last, so you can watch the others.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between gap-3">
          <SegmentedControl<When>
            label="When to update"
            size="sm"
            value={when}
            options={whenOptions}
            onValueChange={setWhen}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPicked(all ? new Set() : new Set(shown.map((choice) => choice.id)))}
          >
            {all ? "Select none" : "Select all"}
          </Button>
        </div>
        <ul id={listId} aria-label="Machines to update" className="-mx-2 flex flex-col">
          {shown.map((choice) => {
            const current = from(choice.id);
            const notes = [
              choice.primary ? "This computer, updates last" : undefined,
              choice.offline ? "Offline, updates once it's back" : undefined,
              choice.busy > 0 ? `${plural(choice.busy, "agent")} at work` : undefined,
            ].filter(Boolean);
            return (
              <li key={choice.id} className="border-b border-border-soft last:border-b-0">
                <label className="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-2.5 hover:bg-hover">
                  <Checkbox
                    className="mt-0.5"
                    checked={picked.has(choice.id)}
                    onCheckedChange={(next) => toggle(choice.id, next === true)}
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-baseline justify-between gap-3 text-ui text-foreground">
                      <span className="truncate">{choice.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {current ? `${current} → ${choice.version}` : `to ${choice.version}`}
                      </span>
                    </span>
                    {notes.length > 0 && (
                      <span className="text-xs text-muted-foreground">{notes.join(" · ")}</span>
                    )}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        <p className="text-xs text-muted-foreground">
          {when === "idle"
            ? "Each machine updates once no agent is working there."
            : agents > 0
              ? `Now restarts them at once. ${plural(agents, "agent")} on ${busy
                  .map((choice) => choice.name)
                  .join(
                    ", ",
                  )} ${agents === 1 ? "stops" : "stop"} while ${busy.length === 1 ? "it restarts" : "they restart"} and ${agents === 1 ? "continues" : "continue"} after.`
              : "Now restarts them at once. No agents are working on them."}
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={chosen.length === 0}
            onClick={() => {
              update.startPicked(new Set(chosen.map((choice) => choice.id)), when);
              props.onClose();
            }}
          >
            {chosen.length === 0
              ? "Update"
              : `Update ${chosen.length === 1 ? (chosen[0]?.name ?? "1 machine") : plural(chosen.length, "machine")}${when === "now" ? " now" : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
