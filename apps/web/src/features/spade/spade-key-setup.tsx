import { splitSpadeModel, type SpadeEndpoint } from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { SettingCard, SettingRow } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { addEndpoint, editAgent, readLiveModels, setKey } from "./spade-api.ts";
import { useSpadeClient } from "./spade-machine.tsx";
import { SpadeModelChoice } from "./spade-model-picker.tsx";
import { modelsKey, useSpadeModels } from "./use-spade-models.ts";
import { agentsKey } from "./use-spade-roster.ts";

/** The presets' key variables in words: "OPENROUTER_API_KEY or OPENCODE_API_KEY". */
function keyVariables(presets: readonly { keyEnv: string | undefined }[]): string {
  const names = [...new Set(presets.flatMap((preset) => (preset.keyEnv ? [preset.keyEnv] : [])))];
  if (!names.length) return "your endpoint's key variable";
  return names.length === 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}

const usable = (endpoint: SpadeEndpoint | undefined) =>
  endpoint !== undefined && (!endpoint.needsKey || endpoint.keySet === true);

/** Its key isn't known yet: the keychain hasn't answered. */
const checking = (endpoint: SpadeEndpoint | undefined) =>
  endpoint !== undefined && endpoint.needsKey && endpoint.keySet === undefined;

/**
 * While Spade's own model is on an endpoint it can't use (none, or one without its key), Spade
 * can't answer. One step fixes it: an endpoint (one of the person's, or a preset added as it is
 * saved), its key when it needs one, and the model Spade answers with (that endpoint's first
 * when the person picks none). Saving moves Spade, the main bot, onto that model before the step
 * closes. The key goes to Spade in one request and the field empties. On a machine without a
 * keychain Spade takes keys only from the environment: it says which.
 */
export function SpadeKeySetup(props: { main: { id: string; model: string } }) {
  const client = useSpadeClient();
  const cache = useQueryClient();
  const models = useSpadeModels(true);
  const [picked, setPicked] = useState<string>();
  const [model, setModel] = useState("");
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const titleId = useId();
  const keyId = useId();
  const modelId = useId();
  const data = models.data;
  const current = splitSpadeModel(props.main.model);
  const main = data?.endpoints.find((endpoint) => endpoint.id === current.endpoint);
  // Never asks for a key the keychain may still hold.
  if (!data || usable(main) || checking(main)) return null;
  const taken = new Set(data.endpoints.map((endpoint) => endpoint.id));
  const options = [
    ...data.endpoints.map((endpoint) => ({
      value: `endpoint:${endpoint.id}`,
      label: endpoint.name,
    })),
    ...data.presets
      .filter((preset) => !taken.has(preset.id))
      .map((preset) => ({ value: `preset:${preset.id}`, label: preset.name })),
  ];
  // An endpoint the person can already use comes first: then only the model is missing.
  const ready = data.endpoints.find(usable);
  const value = picked ?? (ready ? `endpoint:${ready.id}` : options[0]?.value);
  const [kind, id = ""] = value?.split(/:(.*)/s) ?? [];
  const endpoint = kind === "endpoint" ? data.endpoints.find((each) => each.id === id) : undefined;
  const preset = kind === "preset" ? data.presets.find((each) => each.id === id) : undefined;
  const needsKey = preset !== undefined || (endpoint !== undefined && !usable(endpoint));
  const keyless = needsKey && !data.keychain;
  const choose = (next: string) => {
    setPicked(next);
    setModel("");
  };
  const save = async () => {
    const key = draft.trim();
    if (!value || (needsKey && !key)) return;
    setDraft("");
    setSaving(true);
    setError(undefined);
    let changed = false;
    try {
      let target = endpoint;
      if (preset) {
        target = await addEndpoint(client, {
          name: preset.name,
          format: preset.format ?? "openai-chat",
          base_url: preset.baseUrl,
          preset: preset.id,
        });
        // The endpoint exists now, key or not: a second try sets its key, never adds another.
        changed = true;
        setPicked(`endpoint:${target.id}`);
      }
      if (!target) return;
      if (needsKey) await setKey(client, target.id, key);
      changed = true;
      const chosen =
        model ||
        (current.endpoint === target.id ? current.model : "") ||
        target.models[0]?.id ||
        (await readLiveModels(client, target.id).catch(() => []))[0]?.id;
      if (!chosen) {
        setError("Pick the model Spade answers with.");
        return;
      }
      if (`${target.id}/${chosen}` !== props.main.model)
        await editAgent(client, props.main.id, { model: `${target.id}/${chosen}` });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Try again.");
    } finally {
      if (changed)
        await Promise.all([
          cache.invalidateQueries({ queryKey: modelsKey }),
          cache.invalidateQueries({ queryKey: agentsKey }),
        ]);
      setSaving(false);
    }
  };
  return (
    <section aria-labelledby={titleId} className="mb-6 flex max-w-[480px] flex-col gap-4 text-ui">
      <h2 id={titleId} className="text-lg leading-6 font-semibold">
        Pick the model Spade answers with
      </h2>
      {value && (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <SettingCard>
            <SettingRow title="Endpoint" density="compact" inline>
              <Select label="Endpoint" value={value} options={options} onValueChange={choose} />
            </SettingRow>
            {needsKey && (
              <SettingRow
                title="Key"
                htmlFor={keyId}
                description={
                  keyless
                    ? `This machine has no keychain. Set ${keyVariables(data.presets)} where Spade runs, then turn Spade off and on again.`
                    : undefined
                }
                density="compact"
              >
                {!keyless && (
                  <Input
                    id={keyId}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Paste key"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    disabled={saving}
                    className="w-56"
                  />
                )}
              </SettingRow>
            )}
            {endpoint && usable(endpoint) && (
              <SettingRow title="Model" htmlFor={modelId} density="compact" inline>
                <SpadeModelChoice
                  id={modelId}
                  endpoint={endpoint}
                  model={model}
                  onChange={setModel}
                />
              </SettingRow>
            )}
          </SettingCard>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          {!keyless && (
            <div className="flex justify-end">
              <Button type="submit" disabled={saving || (needsKey && !draft.trim())}>
                {needsKey ? "Save key" : "Use this model"}
              </Button>
            </div>
          )}
        </form>
      )}
    </section>
  );
}
