import { spadeUsedByWords, type SpadeEndpoint } from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { editEndpoint, removeEndpoint } from "./spade-api.ts";
import { onHover } from "./spade-account-key.tsx";
import { useSpadeClient } from "./spade-machine.tsx";
import { fault, Refusal } from "./spade-settings-rows.tsx";
import { modelsKey } from "./use-spade-models.ts";

/** What else goes when an account is removed. */
const goesWith = (endpoint: SpadeEndpoint) => {
  if (endpoint.auth === "chatgpt") return " and its sign-in";
  return endpoint.needsKey ? " and its key" : "";
};

/**
 * An account's first row: its name (for an account of a preset), which bots use it, and Rename
 * and Remove. Renaming changes
 * only the name people see: the account's id, and so every model reference on it, stays.
 * Remove asks once; Spade refuses while bots use it, and the reason shows here.
 */
export function AccountHead(props: { endpoint: SpadeEndpoint }) {
  const { endpoint } = props;
  const client = useSpadeClient();
  const cache = useQueryClient();
  const field = useId();
  const [mode, setMode] = useState<"rename" | "remove">();
  const [draft, setDraft] = useState(endpoint.name);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string>();
  const act = async (change: () => Promise<unknown>) => {
    setBusy(true);
    setRefusal(undefined);
    try {
      await change();
      setMode(undefined);
      await cache.invalidateQueries({ queryKey: modelsKey });
    } catch (error) {
      setRefusal(fault(error));
      setMode((now) => (now === "remove" ? undefined : now));
    } finally {
      setBusy(false);
    }
  };
  const rename = () => {
    const name = draft.trim();
    if (!name || name === endpoint.name) return setMode(undefined);
    void act(() => editEndpoint(client, endpoint.id, { name }));
  };
  const used = spadeUsedByWords(endpoint.usedBy) ?? "No bot uses it";
  // One added by its address is its provider's only account: the group's title names it already.
  const named = endpoint.provider !== undefined;
  const description = refusal ? (
    <Refusal>{refusal}</Refusal>
  ) : mode === "remove" ? (
    `Remove ${endpoint.name}${goesWith(endpoint)}?`
  ) : named ? (
    used
  ) : undefined;
  if (mode === "rename")
    return (
      <SettingRow title="Name" htmlFor={field} description={description} density="compact">
        <form
          className="flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            rename();
          }}
        >
          <Input
            id={field}
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- Rename opened the field.
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setMode(undefined);
            }}
            disabled={busy}
            className="w-52"
          />
          <Button size="sm" variant="ghost" onClick={() => setMode(undefined)} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" type="submit" disabled={busy || !draft.trim()}>
            Save
          </Button>
        </form>
      </SettingRow>
    );
  return (
    <SettingRow
      title={named ? <span className="font-medium">{endpoint.name}</span> : used}
      description={description}
      density="compact"
      inline
    >
      {mode === "remove" ? (
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setMode(undefined)} disabled={busy}>
            Keep
          </Button>
          <Button
            size="sm"
            variant="ghost"
            tone="danger"
            disabled={busy}
            onClick={() => void act(() => removeEndpoint(client, endpoint.id))}
          >
            {busy ? "Removing…" : "Remove"}
          </Button>
        </div>
      ) : (
        <div className={onHover}>
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Rename ${endpoint.name}`}
            onClick={() => {
              setDraft(endpoint.name);
              setRefusal(undefined);
              setMode("rename");
            }}
          >
            Rename
          </Button>
          <Button
            size="sm"
            variant="ghost"
            tone="danger"
            aria-label={`Remove ${endpoint.name}`}
            onClick={() => {
              setRefusal(undefined);
              setMode("remove");
            }}
          >
            Remove…
          </Button>
        </div>
      )}
    </SettingRow>
  );
}
