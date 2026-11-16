import type { SpadeCommandsMode } from "@ace/ui-core/spade-chat";
import { useState } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
import { Select } from "@/components/ui/select.tsx";
import { fault } from "./spade-profile-actions.ts";
import { Refusal } from "./spade-settings-rows.tsx";

/** What running outside the sandbox means, in one line (ADR 0171). */
export const outsideSentence =
  "Commands outside the sandbox can reach your files and sign-ins, so each one is reviewed.";

type Choice = SpadeCommandsMode | "inherit";

const modes = [
  { value: "sandboxed", label: "Sandboxed" },
  { value: "outside", label: "Outside the sandbox" },
] as const;

const withInherit = [{ value: "inherit", label: "Same as this Mac" }, ...modes] as const;

/**
 * Where commands run: in the sandbox or outside it. A bot's also offers Same as this Mac
 * (`inherit`); `value` is then "inherit" until it sets its own. Saved as chosen; a refusal says
 * why in the row.
 */
export function CommandsChoice(props: {
  value: Choice;
  /** The machine's setting, which a bot that inherits runs by. */
  effective: SpadeCommandsMode;
  inheritable: boolean;
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
  return (
    <SettingRow
      title="Commands"
      description={
        refusal ? <Refusal>{refusal}</Refusal> : props.effective === "outside" && outsideSentence
      }
      density="compact"
      inline
    >
      <Select<Choice>
        label="Where commands run"
        value={props.value}
        options={props.inheritable ? withInherit : modes}
        disabled={saving}
        onValueChange={(choice) => void choose(choice)}
      />
    </SettingRow>
  );
}
