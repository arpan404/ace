import type { SpadeCommandsMode } from "@ace/ui-core/spade-chat";
import { useState } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
import { Select } from "@/components/ui/select.tsx";
import { fault } from "./spade-profile-actions.ts";
import { Refusal } from "./spade-settings-rows.tsx";

/** What running outside the sandbox means, in one line (ADR 0171). */
export const outsideSentence =
  "Commands run with your own access and nothing contains them, so each one is reviewed.";

type Choice = SpadeCommandsMode | "inherit";

const modes = [
  { value: "sandboxed", label: "Sandboxed" },
  { value: "outside", label: "Outside the sandbox" },
] as const;

/**
 * Where commands run: in the sandbox or outside it, under `title`. A bot's also offers the
 * machine's setting, named by `inherit` ("Same as this Mac"); `value` is then "inherit" until it
 * sets its own. Saved as chosen; a refusal says why in the row.
 */
export function CommandsChoice(props: {
  title: string;
  value: Choice;
  /** The machine's setting, which a bot that inherits runs by. */
  effective: SpadeCommandsMode;
  /** The words for the machine's setting, on a bot's choice only. */
  inherit?: string;
  save(choice: Choice): Promise<unknown>;
}) {
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string>();
  const choose = async (choice: Choice) => {
    setSaving(true);
    setRefusal(undefined);
    try {
      await props.save(choice);
    } catch (error) {
      setRefusal(fault(error));
    } finally {
      setSaving(false);
    }
  };
  const options = props.inherit
    ? [{ value: "inherit" as const, label: props.inherit }, ...modes]
    : modes;
  return (
    <SettingRow
      title={props.title}
      description={
        refusal ? <Refusal>{refusal}</Refusal> : props.effective === "outside" && outsideSentence
      }
      density="compact"
      inline
    >
      <Select<Choice>
        label="Where commands run"
        value={props.value}
        options={options}
        disabled={saving}
        onValueChange={(choice) => void choose(choice)}
      />
    </SettingRow>
  );
}
