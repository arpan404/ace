import { spadeEffortNames, spadeEfforts, type SpadeEffort } from "@ace/ui-core/spade-chat";
import { useState } from "react";
import { Select, type SelectOption } from "@/components/ui/select.tsx";
import { fault, Refusal } from "./spade-settings-rows.tsx";

/** The empty choice: the role follows what is above it (Settings, or its default). */
const follow = "follow";

/**
 * How hard a role's model thinks (ADR 0213), as a select beside its model. The first choice
 * follows what is above it and says what that comes to ("Default: medium thinking"); the rest
 * set it. A refused change says why under the select and it goes back to what is saved.
 */
export function EffortSelect(props: {
  /** The role's title, for the select's name ("Helpers thinking"). */
  title: string;
  /** What is set; undefined where it follows. */
  value: SpadeEffort | undefined;
  /** The first choice's words, such as "Follow Settings" or "Default: medium thinking". */
  none: string;
  save(effort: SpadeEffort | null): Promise<unknown>;
}) {
  const [refusal, setRefusal] = useState<string>();
  const [pending, setPending] = useState<SpadeEffort | typeof follow>();
  const options: SelectOption<SpadeEffort | typeof follow>[] = [
    { value: follow, label: props.none },
    ...spadeEfforts.map((effort) => ({ value: effort, label: spadeEffortNames[effort] })),
  ];
  const choose = async (next: SpadeEffort | typeof follow) => {
    setRefusal(undefined);
    setPending(next);
    try {
      await props.save(next === follow ? null : next);
    } catch (error) {
      setRefusal(fault(error));
    } finally {
      setPending(undefined);
    }
  };
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Select
        label={`${props.title} thinking`}
        value={pending ?? props.value ?? follow}
        options={options}
        disabled={pending !== undefined}
        onValueChange={(next) => void choose(next)}
      />
      {refusal && <Refusal>{refusal}</Refusal>}
    </span>
  );
}

/** What a role with nothing set thinks at, as the first choice's words. */
export function effortDefault(effort: SpadeEffort | undefined): string {
  return effort ? `Default: ${spadeEffortNames[effort].toLowerCase()}` : "Default";
}

/** What a bot's role that follows Settings comes to. */
export function effortFollows(effort: SpadeEffort | undefined): string {
  return effort ? `As in Settings: ${spadeEffortNames[effort].toLowerCase()}` : "As in Settings";
}
