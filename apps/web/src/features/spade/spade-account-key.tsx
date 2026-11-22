import { spadeAccountWords, type SpadeEndpoint } from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { removeKey, setKey } from "./spade-api.ts";
import { useSpadeClient } from "./spade-machine.tsx";
import { fault, Refusal } from "./spade-settings-rows.tsx";
import { modelsKey } from "./use-spade-models.ts";

/** Controls that come up while the pointer is on their row, and always without a pointer. */
export const onHover =
  "flex items-center gap-1.5 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/setting:opacity-100 [@media(hover:hover)]:focus-within:opacity-100 transition-opacity duration-(--motion-fast)";

/**
 * The endpoint's key: saved or not, with Replace and Remove; typed here, it goes to Spade in one
 * request, which keeps it in the OS keychain, and the field empties as it goes. A machine
 * without a keychain takes keys only from the environment.
 */
export function KeyRow(props: { endpoint: SpadeEndpoint; keychain: boolean }) {
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
  const words = spadeAccountWords(endpoint, props.keychain);
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
