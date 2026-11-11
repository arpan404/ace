import { spadeHasUsableEndpoint } from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { addEndpoint, setKey } from "./spade-api.ts";
import { modelsKey, useSpadeModels } from "./use-spade-models.ts";
import { useSpadeClient } from "./spade-machine.tsx";

/** The presets' key variables in words: "OPENROUTER_API_KEY or OPENCODE_API_KEY". */
function keyVariables(presets: readonly { keyEnv: string | undefined }[]): string {
  const names = [...new Set(presets.flatMap((preset) => (preset.keyEnv ? [preset.keyEnv] : [])))];
  if (!names.length) return "your endpoint's key variable";
  return names.length === 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}

/**
 * While none of the person's endpoints can be used (each needs a key and has none), Spade can't
 * answer: one sentence, then a key for an endpoint (or a preset, added as it is saved) right
 * here, or Settings for anything more. The key goes to Spade in one request and the field empties.
 * On a machine without a keychain Spade takes keys only from the environment: it says which.
 */
export function SpadeKeySetup() {
  const client = useSpadeClient();
  const cache = useQueryClient();
  const models = useSpadeModels(true);
  const field = useId();
  const [picked, setPicked] = useState<string>();
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const data = models.data;
  if (!data || spadeHasUsableEndpoint(data.endpoints)) return null;
  // Endpoints still waiting for a key, else the presets to add one from.
  const options = data.endpoints.length
    ? data.endpoints.map((endpoint) => ({ value: `endpoint:${endpoint.id}`, label: endpoint.name }))
    : data.presets.map((preset) => ({ value: `preset:${preset.id}`, label: preset.name }));
  const value = picked ?? options[0]?.value;
  const save = async () => {
    const key = draft.trim();
    if (!key || !value) return;
    setDraft("");
    setSaving(true);
    setError(undefined);
    let changed = false;
    try {
      const [kind, id = ""] = value.split(/:(.*)/s);
      const preset = data.presets.find((candidate) => candidate.id === id);
      let endpoint = id;
      if (kind === "preset" && preset) {
        endpoint = (
          await addEndpoint(client, {
            name: preset.name,
            format: preset.format ?? "openai-chat",
            base_url: preset.baseUrl,
            preset: preset.id,
          })
        ).id;
        // The endpoint exists now, key or not: a second try sets its key, never adds another.
        changed = true;
        setPicked(`endpoint:${endpoint}`);
      }
      await setKey(client, endpoint, key);
      changed = true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Try again.");
    } finally {
      if (changed) await cache.invalidateQueries({ queryKey: modelsKey });
      setSaving(false);
    }
  };
  return (
    <section aria-label="Model key" className="mb-6 flex flex-col gap-2 text-ui">
      <p className="text-muted-foreground">
        Spade needs a key for one of your model endpoints to answer.
      </p>
      {!data.keychain ? (
        <p className="text-muted-foreground">
          {`This machine has no keychain for Spade to keep keys in. Set ${keyVariables(data.presets)} where Spade runs, then turn Spade off and on again.`}{" "}
          <Link to="/settings/spade" className="text-foreground underline underline-offset-3">
            Settings
          </Link>
        </p>
      ) : (
        value && (
          <form
            className="flex flex-wrap items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <Select label="Endpoint" value={value} options={options} onValueChange={setPicked} />
            <Input
              id={field}
              aria-label="Key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste key"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              disabled={saving}
              className="w-56"
            />
            <Button size="sm" type="submit" disabled={saving || !draft.trim()}>
              Save key
            </Button>
            <Link to="/settings/spade" className={buttonVariants({ size: "sm", variant: "ghost" })}>
              Settings
            </Link>
          </form>
        )
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
