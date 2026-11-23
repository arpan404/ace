import {
  spadeAboutYouQuestions,
  spadePresetChoices,
  type SpadeEndpoint,
  type SpadeModels,
} from "@ace/ui-core/spade-chat";

/*
 * First run's cards at the foot of the main Spade's chat, as the phone draws them (web's
 * `spade-key-setup.tsx` and `spade-first-run.tsx`), every word decided here. Pure. A key's value
 * never appears: the card only says whether one is needed.
 */

export interface SpadeSetupOption {
  /** `endpoint:<id>`, `preset:<id>` or `custom`. */
  value: string;
  label: string;
  /** A key must be pasted before this one can answer. */
  key: boolean;
  /** The models to pick from once it can answer; empty picks its first. */
  models: { id: string; name: string }[];
  /** A server of the person's own, by the address they type. */
  address: boolean;
}

export interface SpadeSetupRow {
  title: string;
  options: SpadeSetupOption[];
  /** The one shown first: an endpoint the person can already use, else the first. */
  picked: string;
  keychain: boolean;
  /** On a machine without a keychain, where the key goes instead; null with one. */
  keyless: string | null;
}

export interface SpadeAboutYouRow {
  intro: string;
  questions: { field: string; ask: string; placeholder: string; picks: string[] }[];
}

export type SpadeFootRow = { setup: SpadeSetupRow } | { aboutYou: SpadeAboutYouRow } | null;

export const usable = (endpoint: SpadeEndpoint | undefined) =>
  endpoint !== undefined && (!endpoint.needsKey || endpoint.keySet === true);

/** The presets' key variables in words: "OPENROUTER_API_KEY or OPENCODE_API_KEY". */
function keyVariables(models: SpadeModels): string {
  const names = [...new Set(models.presets.flatMap((preset) => preset.keyEnv ?? []))];
  if (!names.length) return "your endpoint's key variable";
  return names.length === 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}

export function spadeSetupCard(models: SpadeModels): SpadeSetupRow {
  const taken = new Set(models.endpoints.map((endpoint) => endpoint.id));
  const options: SpadeSetupOption[] = [
    ...models.endpoints.map((endpoint) => ({
      value: `endpoint:${endpoint.id}`,
      label: endpoint.name,
      key: !usable(endpoint),
      models: usable(endpoint)
        ? endpoint.models.map((model) => ({ id: model.id, name: model.name || model.id }))
        : [],
      address: false,
    })),
    ...spadePresetChoices(models.presets.filter((preset) => !taken.has(preset.id))).map(
      ({ preset, label }) => ({
        value: `preset:${preset.id}`,
        label,
        key: true,
        models: [],
        address: false,
      }),
    ),
    { value: "custom", label: "Custom or local server", key: false, models: [], address: true },
  ];
  const ready = models.endpoints.find(usable);
  return {
    title: "Pick the model Spade answers with",
    options,
    picked: ready ? `endpoint:${ready.id}` : (options[0]?.value ?? "custom"),
    keychain: models.keychain,
    keyless: models.keychain
      ? null
      : `This machine has no keychain. Set ${keyVariables(models)} where Spade runs, then turn Spade off and on again.`,
  };
}

export const spadeAboutYouCard: SpadeAboutYouRow = {
  intro: "A few things about you, so every bot starts knowing them. Skip any.",
  questions: spadeAboutYouQuestions.map(({ field, ask, placeholder, picks }) => ({
    field,
    ask,
    placeholder,
    picks: [...picks],
  })),
};
