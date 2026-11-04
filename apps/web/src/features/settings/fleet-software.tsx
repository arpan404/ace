import { fleetUpdateNowConfirm, type UpdateLine } from "@ace/ui-core";
import { useState } from "react";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import { HairlineRow, RowAction, RowGroup, StateWords } from "@/components/hairline-row.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import type { Fleet } from "./data/use-fleet.ts";

/**
 * Settings › Fleet's updates: one line, either the offer ("7 machines can update to 0.0.19")
 * with Update all, or the run counting down, and one sentence naming the machines it can't
 * reach. Nothing when every machine is up to date.
 */
export function FleetSoftware(props: { fleet: Fleet }) {
  const update = props.fleet.update;
  const [confirming, setConfirming] = useState<Confirming>();
  const headline = update.headline;
  if (!headline) return null;
  const offer = headline.actions.length > 0;
  return (
    <RowGroup label="Updates">
      <HairlineRow
        data-row="fleet-update"
        title={headline.title}
        sub={headline.note}
        actions={
          offer && (
            <>
              <RowAction className="text-foreground" onClick={() => update.startAll("idle")}>
                Update all
              </RowAction>
              <RowAction
                onClick={() =>
                  setConfirming({
                    ...fleetUpdateNowConfirm(update.plan.targets),
                    run: () => update.startAll("now"),
                  })
                }
              >
                Update all now
              </RowAction>
            </>
          )
        }
      />
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
    </RowGroup>
  );
}

/** A machine row's update words, under its status line. */
export function UpdateWords(props: { line: UpdateLine }) {
  return (
    <span className="block">
      {props.line.tone === "off" ? (
        props.line.words
      ) : (
        <StateWords tone={props.line.tone}>{props.line.words}</StateWords>
      )}
    </span>
  );
}

/** A machine row's Update or Try again, when its update words offer one. */
export function UpdateRowAction(props: {
  fleet: Fleet;
  id: string;
  name: string;
  line: UpdateLine;
}) {
  const toast = useToast();
  const action = props.line.action;
  if (!action) return null;
  const words = action === "retry" ? "Try again" : "Update";
  return (
    <RowAction
      className="text-foreground"
      aria-label={`${words}: ${props.name}`}
      onClick={() =>
        void props.fleet.update.update(props.id).then((problem) => {
          if (problem) toast.error({ title: `${props.name} didn't update`, description: problem });
        })
      }
    >
      {words}
    </RowAction>
  );
}
