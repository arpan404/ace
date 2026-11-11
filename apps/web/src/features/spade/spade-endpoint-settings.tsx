import { spadeFormatNames, spadeModelFacts, type SpadeEndpoint } from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { removeEndpoint, removeKey, removeModel, saveModel, setKey } from "./spade-api.ts";
import { modelsKey } from "./use-spade-models.ts";
import { useSpadeClient } from "./spade-machine.tsx";

const fault = (error: unknown) => (error instanceof Error ? error.message : "Try again.");

/**
 * One of the person's endpoints: where it is, its key, the models saved on it (each removable,
 * and any model id can be added), and Remove endpoint, which Spade refuses while bots use it:
 * its reason shows under the row.
 */
export function EndpointSection(props: { endpoint: SpadeEndpoint; keychain: boolean }) {
  const { endpoint } = props;
  const client = useSpadeClient();
  const cache = useQueryClient();
  const toast = useToast();
  const [refusal, setRefusal] = useState<string>();
  const [removing, setRemoving] = useState(false);
  const refresh = () => cache.invalidateQueries({ queryKey: modelsKey });
  const remove = async () => {
    setRemoving(true);
    setRefusal(undefined);
    try {
      await removeEndpoint(client, endpoint.id);
      await refresh();
    } catch (error) {
      setRefusal(fault(error));
    } finally {
      setRemoving(false);
    }
  };
  const dropModel = async (model: string) => {
    try {
      await removeModel(client, endpoint.id, model);
      await refresh();
    } catch (error) {
      toast.error({ title: "Couldn't remove the model", description: fault(error) });
    }
  };
  return (
    <SettingSection label={endpoint.name}>
      <SettingRow
        title="Address"
        description={[endpoint.format && spadeFormatNames[endpoint.format], endpoint.baseUrl]
          .filter(Boolean)
          .join(" · ")}
        density="compact"
      />
      {endpoint.needsKey && <KeyRow endpoint={endpoint} keychain={props.keychain} />}
      {endpoint.models.map((model) => (
        <SettingRow
          key={model.id}
          title={model.name}
          description={[model.name !== model.id && model.id, spadeModelFacts(model)]
            .filter(Boolean)
            .join(" · ")}
          density="compact"
          inline
        >
          {/* Only the person's saved models can go; the preset's come with the endpoint. */}
          {model.source !== "preset" && (
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Remove ${model.name}`}
              onClick={() => void dropModel(model.id)}
            >
              Remove
            </Button>
          )}
        </SettingRow>
      ))}
      <AddModelRow endpoint={endpoint} />
      <SettingRow
        title="Remove endpoint"
        description={
          refusal ? (
            <span role="alert" className="text-destructive">
              {refusal}
            </span>
          ) : (
            "Its key goes with it."
          )
        }
        density="compact"
        inline
      >
        <Button
          size="sm"
          variant="ghost"
          tone="danger"
          aria-label={`Remove ${endpoint.name}`}
          disabled={removing}
          onClick={() => void remove()}
        >
          {removing ? "Removing…" : "Remove"}
        </Button>
      </SettingRow>
    </SettingSection>
  );
}

/** Saves a model id the endpoint serves, typed in, so it is offered first. */
function AddModelRow(props: { endpoint: SpadeEndpoint }) {
  const client = useSpadeClient();
  const cache = useQueryClient();
  const toast = useToast();
  const field = useId();
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const add = async () => {
    const id = draft.trim();
    if (!id) return;
    setSaving(true);
    try {
      await saveModel(client, props.endpoint.id, { id });
      setDraft("");
      await cache.invalidateQueries({ queryKey: modelsKey });
    } catch (error) {
      toast.error({ title: "Couldn't save the model", description: fault(error) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingRow title="Add a model" htmlFor={field} density="compact">
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <Input
          id={field}
          placeholder="Model id"
          spellCheck={false}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={saving}
          className="w-52"
        />
        <Button size="sm" type="submit" disabled={saving || !draft.trim()}>
          Add
        </Button>
      </form>
    </SettingRow>
  );
}

/**
 * The endpoint's key: typed here, it goes to Spade in one request, which keeps it in the OS
 * keychain; the field empties as it goes and the key is never kept anywhere in the app.
 */
function KeyRow(props: { endpoint: SpadeEndpoint; keychain: boolean }) {
  const { endpoint } = props;
  const client = useSpadeClient();
  const cache = useQueryClient();
  const toast = useToast();
  const field = useId();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const change = async (action: "set" | "remove") => {
    const key = draft.trim();
    // The field empties before the request goes, so the key lives only in this call.
    setDraft("");
    setSending(true);
    try {
      if (action === "set") await setKey(client, endpoint.id, key);
      else await removeKey(client, endpoint.id);
      await cache.invalidateQueries({ queryKey: modelsKey });
    } catch (error) {
      toast.error({
        title: action === "set" ? "Couldn't save the key" : "Couldn't remove the key",
        description: fault(error),
      });
    } finally {
      setSending(false);
    }
  };
  if (!props.keychain)
    return (
      <SettingRow
        title="Key"
        description={
          endpoint.keySource === "environment"
            ? "Set from the environment."
            : "This machine has no keychain. Set the endpoint's environment variable for Spade."
        }
      />
    );
  return (
    <SettingRow
      title="Key"
      htmlFor={field}
      description={
        endpoint.keySource === "environment"
          ? "Set from the environment. A key saved here is used instead."
          : endpoint.keySet
            ? "Set"
            : "Not set. Spade can't use these models without it."
      }
    >
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.trim()) void change("set");
        }}
      >
        <Input
          id={field}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={endpoint.keySet ? "Replace key" : "Paste key"}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={sending}
          className="w-52"
        />
        <Button size="sm" type="submit" disabled={sending || !draft.trim()}>
          Save
        </Button>
        {/* Only a key in the keychain can be removed from here; the environment's stays. */}
        {endpoint.keySource === "keychain" && (
          <Button
            size="sm"
            variant="ghost"
            tone="danger"
            disabled={sending}
            onClick={() => void change("remove")}
          >
            Remove
          </Button>
        )}
      </form>
    </SettingRow>
  );
}
