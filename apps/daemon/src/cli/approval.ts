import type { Interaction } from "@ace/protocol";
import { allowResolution, denyResolution } from "./work/answers.ts";

/** `y`/`n` in chat and the old `thread approve|deny`: allow once or deny, or the option named. */
export function approval(interaction: Interaction, verb: string, selected: string | undefined) {
  return verb === "approve"
    ? allowResolution(interaction, { option: selected })
    : denyResolution(interaction, { option: selected });
}
