import { spadeFormatNames, spadeModelFacts, type SpadeEndpoint } from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { SettingAddRow, SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { removeEndpoint, removeKey, removeModel, saveModel, setKey } from "./spade-api.ts";
import { modelsKey } from "./use-spade-models.ts";
import { useSpadeClient } from "./spade-machine.tsx";
import { fault, Refusal } from "./spade-settings-rows.tsx";

/** Controls that come up while the pointer is on their row, and always without a pointer. */
const onHover =
  "flex items-center gap-1.5 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/setting:opacity-100 [@media(hover:hover)]:focus-within:opacity-100 transition-opacity duration-(--motion-fast)";

/**
 * One of the person's endpoints: where it is, its key (saved or not; it never shows), the
 * models saved on it (the person's own can go) and Add a model; under it, Remove, which asks
 * once and says the key goes too. Spade refuses while bots use it: the reason shows there.
 */
export function EndpointSection(props: { endpoint: SpadeEndpoint; keychain: boolean }) {
  const { endpoint } = props;
  const client = useSpadeClient();
  const cache = useQueryClient();
  const toast = useToast();
  const refresh = () => cache.invalidateQueries({ queryKey: modelsKey });
  const dropModel = async (model: string) => {
    try {
      await removeModel(client, endpoint.id, model);
      await refresh();
    } catch (error) {
      toast.error({ title: "Couldn't remove the model", description: fault(error) });
    }
  };
  return (
    <div>
      <SettingSection label={endpoint.name}>
        <SettingRow
          title="Address"
          description={<span className="font-mono break-all">{endpoint.baseUrl}</span>}
          density="compact"
        >
          {endpoint.format && (
            <span className="text-ui text-muted-foreground">
              {spadeFormatNames[endpoint.format]}
            </span>
          )}
        </SettingRow>
        {endpoint.needsKey && <KeyRow endpoint={endpoint} keychain={props.keychain} />}
        {endpoint.models.map((model) => (
          <SettingRow
            key={model.id}
            title={model.name}
            description={
              <>
                <span className="font-mono">{model.id}</span>
                {spadeModelFacts(model) && ` · ${spadeModelFacts(model)}`}
              </>
            }
            density="compact"
            inline
          >
            {/* Only the person's saved models can go; the preset's come with the endpoint. */}
            {model.source !== "preset" && (
              <div className={onHover}>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${model.name}`}
                  onClick={() => void dropModel(model.id)}
                >
                  Remove
                </Button>
              </div>
            )}
          </SettingRow>
        ))}
        <AddModelRow endpoint={endpoint} />
      </SettingSection>
      <RemoveEndpoint endpoint={endpoint} />
    </div>
  );
}

/** Removing the endpoint: a danger word under its group that asks once, then says why not. */
function RemoveEndpoint(props: { endpoint: SpadeEndpoint }) {
  const { endpoint } = props;
  const client = useSpadeClient();
  const cache = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [refusal, setRefusal] = useState<string>();
  const remove = async () => {
    setRemoving(true);
    setRefusal(undefined);
    try {
      await removeEndpoint(client, endpoint.id);
      await cache.invalidateQueries({ queryKey: modelsKey });
    } catch (error) {
      setRefusal(fault(error));
      setAsking(false);
    } finally {
      setRemoving(false);
    }
  };
  return (
    <div className="-mt-6 mb-8 flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-ui">
      {refusal && (
        <span className="mr-auto text-xs">
          <Refusal>{refusal}</Refusal>
        </span>
      )}
      {asking ? (
        <>
          <span className="text-muted-foreground">
            {endpoint.needsKey
              ? `Remove ${endpoint.name} and its key?`
              : `Remove ${endpoint.name}?`}
          </span>
          <Button size="sm" variant="ghost" onClick={() => setAsking(false)} disabled={removing}>
            Keep
          </Button>
          <Button
            size="sm"
            variant="ghost"
            tone="danger"
            disabled={removing}
            onClick={() => void remove()}
          >
            {removing ? "Removing…" : "Remove"}
          </Button>
        </>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          tone="danger"
          aria-label={`Remove ${endpoint.name}`}
          onClick={() => setAsking(true)}
        >
          {`Remove ${endpoint.name}…`}
        </Button>
      )}
    </div>
  );
}

/** Add a model: a row that opens to a model id field, saved so it is offered first. */
function AddModelRow(props: { endpoint: SpadeEndpoint }) {
  const client = useSpadeClient();
  const cache = useQueryClient();
  const field = useId();
  const [draft, setDraft] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string>();
  if (draft === undefined)
    return <SettingAddRow onClick={() => setDraft("")}>Add a model</SettingAddRow>;
  const add = async () => {
    const id = draft.trim();
    if (!id) return;
    setSaving(true);
    setRefusal(undefined);
    try {
      await saveModel(client, props.endpoint.id, { id });
      setDraft(undefined);
      await cache.invalidateQueries({ queryKey: modelsKey });
    } catch (error) {
      setRefusal(fault(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingRow
      title="Model id"
      description={refusal && <Refusal>{refusal}</Refusal>}
      htmlFor={field}
      density="compact"
    >
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <Input
          id={field}
          placeholder="deepseek-v4.1-flash"
          spellCheck={false}
          autoComplete="off"
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the field opens because the person asked for it.
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setDraft(undefined);
          }}
          disabled={saving}
          className="w-52"
        />
        <Button size="sm" variant="ghost" onClick={() => setDraft(undefined)}>
          Cancel
        </Button>
        <Button size="sm" type="submit" disabled={saving || !draft.trim()}>
          Add
        </Button>
      </form>
    </SettingRow>
  );
}

/** The key's state in words: it is saved or not, never shown. */
function keyWords(endpoint: SpadeEndpoint, keychain: boolean): string {
  if (endpoint.keySet === undefined) return "Checking the keychain…";
  if (endpoint.keySource === "environment") return "From the environment";
  if (!keychain) return "Set its environment variable where Spade runs";
  return endpoint.keySet ? "Saved in the keychain" : "Not saved";
}

/**
 * The endpoint's key: saved or not, with Replace and Remove; typed here, it goes to Spade in one
 * request, which keeps it in the OS keychain, and the field empties as it goes. A machine
 * without a keychain takes keys only from the environment.
 */
function KeyRow(props: { endpoint: SpadeEndpoint; keychain: boolean }) {
  const { endpoint } = props;
  const client = useSpadeClient();
  const cache = useQueryClient();
  const field = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<string>();
  const change = async (action: "set" | "remove") => {
    const key = draft.trim();
    // The field empties before the request goes, so the key lives only in this call.
    setDraft("");
    setSending(true);
    setRefusal(undefined);
    try {
      if (action === "set") await setKey(client, endpoint.id, key);
      else await removeKey(client, endpoint.id);
      setEditing(false);
      await cache.invalidateQueries({ queryKey: modelsKey });
    } catch (error) {
      setRefusal(fault(error));
    } finally {
      setSending(false);
    }
  };
  const words = keyWords(endpoint, props.keychain);
  const asking = props.keychain && (editing || endpoint.keySet === false);
  return (
    <SettingRow
      title="Key"
      htmlFor={asking ? field : undefined}
      description={refusal ? <Refusal>{refusal}</Refusal> : words}
      density="compact"
      inline={!asking}
    >
      {asking ? (
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
            placeholder="Paste key"
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- Replace opened the field.
            autoFocus={editing}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setEditing(false);
            }}
            disabled={sending}
            className="w-52"
          />
          {editing && (
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          )}
          <Button size="sm" type="submit" disabled={sending || !draft.trim()}>
            Save
          </Button>
        </form>
      ) : (
        props.keychain &&
        endpoint.keySet !== undefined && (
          <div className={onHover}>
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)} disabled={sending}>
              Replace
            </Button>
            {/* Only a key in the keychain can be removed from here; the environment's stays. */}
            {endpoint.keySource === "keychain" && (
              <Button
                size="sm"
                variant="ghost"
                tone="danger"
                aria-label="Remove key"
                disabled={sending}
                onClick={() => void change("remove")}
              >
                Remove
              </Button>
            )}
          </div>
        )
      )}
    </SettingRow>
  );
}
