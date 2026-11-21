import { spadeFullAccessSentence, type SpadeAutonomy } from "@ace/ui-core/spade-chat";
import { isStandingRefusal } from "@/boot/person-standing.ts";
import { ConfirmPerson } from "@/features/ace-account/index.ts";
import { useSpadeClient } from "./spade-machine.tsx";
import { useState } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Select } from "@/components/ui/select.tsx";
import { fault } from "./spade-profile-actions.ts";
import { Refusal } from "./spade-settings-rows.tsx";

const modes = [
  { value: "auto_review", label: "Auto-review" },
  { value: "full_access", label: "Full access" },
] as const;

/**
 * How a bot decides (ADR 0163, amendment 2): Auto-review, every bot's default, or Full access.
 * Full access says what still asks under the row while it is on. Turning it on asks first, in
 * words, unless the person already confirmed it for this bot (`confirmed`); the machine's default
 * always asks. Saved as chosen; a refusal says why in the row.
 */
export function AutonomyChoice(props: {
  title: string;
  value: SpadeAutonomy;
  /** Who gets it, for the confirmation: a bot's name, or "every bot that doesn't set its own". */
  who: string;
  confirmed: boolean;
  save(choice: SpadeAutonomy): Promise<unknown>;
}) {
  const [saving, setSaving] = useState(false);
  const client = useSpadeClient();
  const [confirmation, setConfirmation] = useState<SpadeAutonomy>();
  const [refusal, setRefusal] = useState<string>();
  const [asking, setAsking] = useState(false);
  const choose = async (choice: SpadeAutonomy) => {
    setSaving(true);
    setRefusal(undefined);
    setConfirmation(undefined);
    try {
      await props.save(choice);
    } catch (error) {
      const message = fault(error);
      if (isStandingRefusal(message)) setConfirmation(choice);
      else setRefusal(message);
    } finally {
      setSaving(false);
    }
  };
  const pick = (choice: SpadeAutonomy) => {
    if (choice === props.value) return;
    if (choice === "full_access" && !props.confirmed) setAsking(true);
    else void choose(choice);
  };
  return (
    <>
      <SettingRow
        title={props.title}
        description={
          confirmation ? (
            <ConfirmPerson client={client} onConfirmed={() => void choose(confirmation)} />
          ) : (
            refusal && <Refusal>{refusal}</Refusal>
          )
        }
        density="compact"
        inline
      >
        <Select<SpadeAutonomy>
          label={props.title}
          value={props.value}
          options={modes}
          disabled={saving}
          onValueChange={pick}
        />
      </SettingRow>
      {/* What still asks, the row's width: too long for the description beside the choice. */}
      {props.value === "full_access" && !refusal && !confirmation && (
        <p data-setting-slot="" className="pb-3 text-xs text-muted-foreground">
          {spadeFullAccessSentence}
        </p>
      )}
      <Dialog open={asking} onOpenChange={(open) => !open && setAsking(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Turn on Full access for {props.who}?</DialogTitle>
            <DialogDescription>
              {spadeFullAccessSentence} Full access doesn't change what the sandbox allows, and
              every step still shows in the chat.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAsking(false)}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setAsking(false);
                void choose("full_access");
              }}
            >
              Turn on Full access
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
