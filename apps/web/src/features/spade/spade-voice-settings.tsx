import { useId, useSyncExternalStore } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
import { Select, type SelectOption } from "@/components/ui/select.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { canReadAloud, systemVoices } from "./spade-speech.ts";
import { endpointVoices } from "./spade-voice-models.ts";
import { botVoice, setVoiceChoice, useVoicePrefs } from "./spade-voice-prefs.ts";

/*
 * How replies sound (ADR 0134, amended): Speak replies and the voice, for every bot (Settings ›
 * Spade) or for one (its profile), kept on this device. With a speech model set, the voices are
 * that model's; otherwise the system's own, which cost nothing and never leave the device.
 */

/** "Default" in a bot's own rows: it follows Settings. */
const follow = "";

function subscribeVoices(listener: () => void) {
  if (!canReadAloud() || typeof speechSynthesis.addEventListener !== "function") return () => {};
  speechSynthesis.addEventListener("voiceschanged", listener);
  return () => speechSynthesis.removeEventListener("voiceschanged", listener);
}

let voicesSeen: { key: string; voices: SpeechSynthesisVoice[] } | undefined;
/** The system's voices; the same array until they change, as `useSyncExternalStore` needs. */
function voicesNow(): SpeechSynthesisVoice[] {
  const voices = systemVoices();
  const key = voices.map((voice) => voice.voiceURI).join("\n");
  if (voicesSeen?.key !== key) voicesSeen = { key, voices };
  return voicesSeen.voices;
}

/** The system's voices, as they load. */
export function useSystemVoices(): SpeechSynthesisVoice[] {
  return useSyncExternalStore(subscribeVoices, voicesNow, () => []);
}

/** The voices to choose from, the device's language first. */
function voiceOptions(
  speechModel: string | undefined,
  system: readonly SpeechSynthesisVoice[],
): SelectOption<string>[] {
  if (speechModel) return endpointVoices.map((voice) => ({ value: voice, label: titled(voice) }));
  const language = (typeof navigator === "undefined" ? "" : navigator.language).split("-")[0];
  return system
    .toSorted(
      (a, b) =>
        Number(b.lang.startsWith(language ?? "")) - Number(a.lang.startsWith(language ?? "")) ||
        a.name.localeCompare(b.name),
    )
    .map((voice) => ({ value: voice.voiceURI, label: `${voice.name} · ${voice.lang}` }));
}

const titled = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/**
 * Speak replies and Voice. `bot` set: one bot's rows, where Default follows Settings; unset:
 * the defaults every bot follows.
 */
export function VoiceRows(props: { bot?: string | undefined; speechModel: string | undefined }) {
  const switchId = useId();
  const prefs = useVoicePrefs();
  const system = useSystemVoices();
  const { bot, speechModel } = props;
  const own = bot ? (prefs.bots[bot] ?? {}) : prefs.defaults;
  const effective = botVoice(prefs, bot);
  const canSpeak = speechModel !== undefined || canReadAloud();
  const field = speechModel ? "endpointVoice" : "systemVoice";
  const chosen = own[field];
  const defaults = botVoice(prefs, undefined)[field];
  const options = voiceOptions(speechModel, system);
  const named = (value: string | undefined) =>
    options.find((option) => option.value === value)?.label;
  const first: SelectOption<string> = bot
    ? { value: follow, label: `Default (${named(defaults) ?? (speechModel ? "Alloy" : "System")})` }
    : { value: follow, label: speechModel ? "Alloy" : "The system's default" };
  return (
    <>
      <SettingRow
        title="Speak replies"
        description={
          canSpeak
            ? bot
              ? "Replies are read aloud as they're written. Spoken messages are always answered aloud."
              : "Every bot reads its replies aloud. Spoken messages are always answered aloud."
            : "This device can't speak, and no speech model is set."
        }
        htmlFor={switchId}
        density="compact"
        inline
      >
        <Switch
          id={switchId}
          checked={effective.speakReplies}
          disabled={!canSpeak}
          onCheckedChange={(checked) => setVoiceChoice(bot, { speakReplies: checked })}
        />
      </SettingRow>
      {canSpeak && (
        <SettingRow title="Voice" density="compact" inline>
          <Select<string>
            label="Voice"
            value={chosen ?? follow}
            options={[first, ...options.filter((option) => option.value !== follow)]}
            onValueChange={(value) => setVoiceChoice(bot, { [field]: value || undefined })}
          />
        </SettingRow>
      )}
    </>
  );
}
