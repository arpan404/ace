import {
  parseSpadePersonality,
  spadePersonalityBody,
  spadeQuietPersonality,
  spadeTones,
  type SpadePersonality,
  type SpadeTone,
} from "@ace/ui-core/spade-chat";
import { useId, useState } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
import { Select, type SelectOption } from "@/components/ui/select.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useEditBot } from "./spade-profile-actions.ts";
import { AccentRow } from "./spade-profile-accent.tsx";
import { ProfileSection } from "./spade-profile-parts.tsx";
import { Refusal } from "./spade-settings-rows.tsx";
import type { RosterBot } from "./use-spade-roster.ts";

const own = "own";
type ToneChoice = SpadeTone | typeof own;

const toneOptions: readonly SelectOption<ToneChoice>[] = [
  { value: own, label: "Its own way" },
  ...spadeTones.map((tone) => ({ value: tone.value, label: `${tone.label}: ${tone.says}` })),
];

/**
 * Personality, a section of Details: how the bot talks (its tone, humour, emoji), saved as each
 * changes and taken from its next turn as its own section of the standing instructions, apart
 * from the task. Humour and emoji are off unless the person turns them on.
 */
export function ProfilePersonality(props: { bot: RosterBot }) {
  const { bot } = props;
  const edit = useEditBot(bot);
  const stored = parseSpadePersonality(bot.raw.personality) ?? spadeQuietPersonality;
  // What the person just chose, shown at once while it saves.
  const [shown, setShown] = useState<SpadePersonality>();
  const [refusal, setRefusal] = useState<string>();
  const now = shown ?? stored;
  const save = async (next: SpadePersonality) => {
    setShown(next);
    setRefusal(undefined);
    const refused = await edit({ personality: spadePersonalityBody(next) });
    setRefusal(refused);
    setShown(undefined);
  };
  return (
    <ProfileSection label="Personality">
      <PersonalityRows value={now} onChange={(next) => void save(next)} />
      {bot.kind !== "main" && <AccentRow bot={bot} />}
      {refusal && (
        <p data-setting-slot="" className="py-2 text-xs">
          <Refusal>{refusal}</Refusal>
        </p>
      )}
    </ProfileSection>
  );
}

/**
 * How a bot talks, as three rows: its tone, humour and emoji. Controlled: the profile saves each
 * change, New bot's More settings keeps it for the bot it makes.
 */
export function PersonalityRows(props: {
  value: SpadePersonality;
  onChange(next: SpadePersonality): void;
}) {
  const now = props.value;
  const save = props.onChange;
  const ids = { tone: useId(), humour: useId(), emoji: useId() };
  return (
    <>
      <SettingRow
        title="Tone"
        description="How it talks. Only its style changes, never its task."
        htmlFor={ids.tone}
        density="compact"
      >
        <Select<ToneChoice>
          id={ids.tone}
          label="Tone"
          value={now.tone ?? own}
          options={toneOptions}
          onValueChange={(tone) => save({ ...now, tone: tone === own ? undefined : tone })}
          className="w-56 max-w-full"
        />
      </SettingRow>
      <SettingRow title="Humour" htmlFor={ids.humour} density="compact" inline>
        <Switch
          id={ids.humour}
          checked={now.humour}
          onCheckedChange={(humour) => save({ ...now, humour })}
        />
      </SettingRow>
      <SettingRow title="Emoji" htmlFor={ids.emoji} density="compact" inline>
        <Switch
          id={ids.emoji}
          checked={now.emoji}
          onCheckedChange={(emoji) => save({ ...now, emoji })}
        />
      </SettingRow>
    </>
  );
}
