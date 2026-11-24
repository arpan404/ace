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
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { Select } from "@/components/ui/select.tsx";
import { cn } from "@/lib/cn.ts";
import { fault } from "./spade-profile-actions.ts";
import { Refusal } from "./spade-settings-rows.tsx";

const modes = [
  {
    value: "auto_review",
    label: "Auto-review",
    summary:
      "A reviewer checks each step that changes something and decides for you. You're asked only if it refuses the same step twice, or for the three below.",
  },
  {
    value: "full_access",
    label: "Full access",
    summary:
      "Runs every step itself, inside or outside the sandbox, with nothing reviewed. Only the three below come to you.",
  },
] as const;

/**
 * How a bot decides (ADR 0163, amendment 2): Auto-review, every bot's default, or Full access.
 * Turning Full access on asks first, in words, unless the person already confirmed it for this bot
 * (`confirmed`); the machine's default always asks. Saved as chosen; a refusal says why in place.
 */
export function AutonomyChoice(props: {
  title: string;
  value: SpadeAutonomy;
  /** Who gets it, for the confirmation: a bot's name, or "every bot that doesn't set its own". */
  who: string;
  confirmed: boolean;
  /** Segmented control in a bot's profile; select in Settings › Spade › Security. */
  variant?: "select" | "segmented";
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
  const feedback = confirmation ? (
    <ConfirmPerson client={client} onConfirmed={() => void choose(confirmation)} />
  ) : (
    refusal && <Refusal>{refusal}</Refusal>
  );
  const selected = modes.find((mode) => mode.value === props.value) ?? modes[0];
  return (
    <>
      {props.variant === "segmented" ? (
        <div data-setting-slot="" className="flex flex-col gap-2.5 py-3">
          <SegmentedControl<SpadeAutonomy>
            label={props.title}
            value={props.value}
            options={modes.map(({ value, label }) => ({ value, label }))}
            onValueChange={pick}
            className={cn(
              "h-8 w-full [&>button]:h-7",
              saving && "pointer-events-none opacity-60",
            )}
          />
          <p className="px-0.5 text-xs leading-relaxed text-muted-foreground">{selected.summary}</p>
          {feedback && <div className="text-xs">{feedback}</div>}
        </div>
      ) : (
        <>
          <SettingRow title={props.title} description={feedback} density="compact" inline>
            <Select<SpadeAutonomy>
              label={props.title}
              value={props.value}
              options={modes.map(({ value, label }) => ({ value, label }))}
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
        </>
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
