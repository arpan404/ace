import {
  machineSoftware,
  softwareActionWords,
  updateNowConfirm,
  type SoftwareAction,
} from "@ace/ui-core";
import { useState } from "react";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import { HairlineRow, RowAction, RowGroup, StateWords } from "@/components/hairline-row.tsx";
import type { Machine } from "@/lib/machines.ts";
import type { Fleet } from "./data/use-fleet.ts";

/**
 * A machine page's Software: what ace version it runs, the release on offer and the update's
 * progress, with Update when idle and Update now (asked first, naming the agents it stops).
 * A machine this window only reads shows the same words without the actions.
 */
export function MachineSoftware(props: { machine: Machine; fleet: Fleet }) {
  const { machine, fleet } = props;
  const update = fleet.update;
  const facts = update.machines.find((entry) => entry.id === machine.id);
  const [confirming, setConfirming] = useState<Confirming>();
  const [problem, setProblem] = useState("");
  if (!facts) return null;
  const view = machineSoftware(facts);
  const version = facts.update?.available;
  const start = (mode: "idle" | "now") =>
    void update.update(machine.id, mode).then((words) => setProblem(words ?? ""));
  const act = (action: SoftwareAction) => {
    setProblem("");
    if (action === "idle" || action === "retry") start("idle");
    else if (action === "now" && version)
      setConfirming({
        ...updateNowConfirm({ name: machine.name, version, busy: facts.update?.busy ?? 0 }),
        run: () => start("now"),
      });
    else if (action === "cancel" || action === "check") void update.operation(machine.id, action);
  };
  return (
    <RowGroup label="Software">
      <HairlineRow
        data-row="machine-software"
        title={view.line}
        sub={
          (view.progress || view.note || view.link) && (
            <>
              {view.progress && (
                <span className="block">
                  {view.progressTone === "off" ? (
                    view.progress
                  ) : (
                    <StateWords tone={view.progressTone}>{view.progress}</StateWords>
                  )}
                </span>
              )}
              {view.note && <span className="block">{view.note}</span>}
              {view.link && (
                <a
                  href={view.link.url}
                  target="_blank"
                  rel="noreferrer"
                  className="relative z-1 block w-fit rounded-xs text-foreground underline-offset-2 focus-ring hover:underline"
                >
                  {view.link.words}
                </a>
              )}
            </>
          )
        }
        actions={
          view.actions.length > 0 &&
          view.actions.map((action, index) => (
            <RowAction
              key={action}
              className={index === 0 ? "text-foreground" : undefined}
              onClick={() => act(action)}
            >
              {softwareActionWords[action]}
            </RowAction>
          ))
        }
      >
        {problem && (
          <p role="alert" className="pb-2.5 text-xs text-destructive">
            {problem}
          </p>
        )}
      </HairlineRow>
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
    </RowGroup>
  );
}
