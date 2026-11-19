import {
  spadeModelState,
  spadePresetChoices,
  spadeServerName,
  splitSpadeModel,
  type SpadeEndpoint,
} from "@ace/ui-core/spade-chat";
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

/** The card's element id: Set up a model brings it into view. */
const setupId = "spade-model-setup";

/**
 * Brings the setup card into view and puts focus on its first control. False when it isn't
 * showing (Spade's model is fine, or this isn't Spade's conversation).
 */
export function showModelSetup(): boolean {
  const card = document.getElementById(setupId);
  if (!card) return false;
  card.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  card.querySelector<HTMLElement>("button, input")?.focus({ preventScroll: true });
  return true;
}

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

/** The choice that adds a server by its address: one of the person's own, or on this computer. */
const custom = "custom:";

/** An address as Spade keeps it: trimmed, ending in `/` so model paths join onto it. */
const address = (typed: string) => {
  const trimmed = typed.trim();
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
};

const words = (failure: unknown) =>
  failure instanceof Error ? failure.message : "it didn't answer";

/**
 * While Spade has no model it can use (none chosen, or one on an endpoint without its key),
 * Spade can't answer. One step fixes it: an endpoint (one of the person's, a service added as it
 * is saved, or a server of their own by its address, such as one on this computer), its key when
 * it needs one, and the model Spade answers with (that endpoint's first when the person picks
 * none). Saving moves Spade, the main bot, onto that model before the step closes. The key goes
 * to Spade in one request and the field empties. On a machine without a keychain Spade takes
 * keys only from the environment: it says which.
 */
export function SpadeKeySetup(props: { main: { id: string; model: string } }) {
  const client = useSpadeClient();
  const cache = useQueryClient();
  const models = useSpadeModels(true);
  const [picked, setPicked] = useState<string>();
  const [model, setModel] = useState("");
  const [draft, setDraft] = useState("");
  const [server, setServer] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const titleId = useId();
  const keyId = useId();
  const modelId = useId();
  const serverId = useId();
  const data = models.data;
  const current = splitSpadeModel(props.main.model);
  // Never asks for a key the keychain may still hold.
  if (!data || spadeModelState(props.main.model, data.endpoints) !== "none") return null;
  const taken = new Set(data.endpoints.map((endpoint) => endpoint.id));
  const options = [
    ...data.endpoints.map((endpoint) => ({
      value: `endpoint:${endpoint.id}`,
      label: endpoint.name,
    })),
    ...spadePresetChoices(data.presets.filter((preset) => !taken.has(preset.id))).map(
      ({ preset, label }) => ({ value: `preset:${preset.id}`, label }),
    ),
    { value: custom, label: "Custom or local server" },
  ];
  // An endpoint the person can already use comes first: then only the model is missing.
  const ready = data.endpoints.find(usable);
  const value = picked ?? (ready ? `endpoint:${ready.id}` : options[0]?.value);
  const [kind, id = ""] = value?.split(/:(.*)/s) ?? [];
  const endpoint = kind === "endpoint" ? data.endpoints.find((each) => each.id === id) : undefined;
  const preset = kind === "preset" ? data.presets.find((each) => each.id === id) : undefined;
  const own = kind === "custom";
  const serverName = spadeServerName(server);
  const needsKey = preset !== undefined || (endpoint !== undefined && !usable(endpoint));
  const keyless = needsKey && !data.keychain;
  const choose = (next: string) => {
    setPicked(next);
    setModel("");
    setError(undefined);
  };
  /** Adds the server at the typed address; it needs a key only when one was typed. */
  const addServer = async (key: string) => {
    const added = await addEndpoint(client, {
      name: serverName ?? "My server",
      format: "openai-chat",
      base_url: address(server),
      ...(key ? {} : { needs_key: false }),
    });
    setPicked(`endpoint:${added.id}`);
    setServer("");
    return added;
  };
  /** The model to use on `target`: the one picked, else Spade's own there, else its first. */
  const firstModel = async (target: SpadeEndpoint) => {
    const known =
      model || (current.endpoint === target.id ? current.model : "") || target.models[0]?.id;
    if (known) return known;
    try {
      const listed = (await readLiveModels(client, target.id))[0]?.id;
      if (listed) return listed;
      setError("It lists no models. Type the id of the model Spade should answer with.");
    } catch (failure) {
      setError(
        `Couldn't list its models: ${words(failure)}. Check the address, or type a model id.`,
      );
    }
    return undefined;
  };
  const save = async () => {
    const key = draft.trim();
    if (!value || (needsKey && !key) || (own && !serverName)) return;
    setDraft("");
    setSaving(true);
    setError(undefined);
    let changed = false;
    try {
      let target = endpoint;
      if (own) {
        target = await addServer(key);
        changed = true;
      } else if (preset) {
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
      if (needsKey || (own && key)) await setKey(client, target.id, key);
      changed = true;
      const chosen = await firstModel(target);
      if (!chosen) return;
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
  const action = own ? "Add server" : needsKey ? "Save key" : "Use this model";
  const waiting = (needsKey && !draft.trim()) || (own && !serverName);
  return (
    <section
      id={setupId}
      aria-labelledby={titleId}
      className="mb-6 flex max-w-[480px] flex-col gap-4 text-ui"
    >
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
            {own && (
              <SettingRow
                title="Address"
                htmlFor={serverId}
                description="Ollama, LM Studio and most other servers work as they are."
                density="compact"
              >
                <Input
                  id={serverId}
                  type="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="http://localhost:11434/v1/"
                  value={server}
                  onChange={(event) => setServer(event.target.value)}
                  disabled={saving}
                  className="w-56"
                />
              </SettingRow>
            )}
            {(needsKey || (own && data.keychain)) && (
              <SettingRow
                title="Key"
                htmlFor={keyId}
                description={
                  keyless
                    ? `This machine has no keychain. Set ${keyVariables(data.presets)} where Spade runs, then turn Spade off and on again.`
                    : own
                      ? "Only if the server asks for one."
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
                    placeholder={own ? "None" : "Paste key"}
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
              <Button type="submit" disabled={saving || waiting}>
                {action}
              </Button>
            </div>
          )}
        </form>
      )}
    </section>
  );
}
