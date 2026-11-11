import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import { parseSpadeModels, spadeStateLine, type SpadeEndpoint } from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { segment, spadeHttp } from "./spade-requests.ts";
import { useSpadeEnabled } from "./use-spade-enabled.ts";
import { useSpadeStatus } from "./use-spade-status.ts";

const modelsKey = ["spade", "models"] as const;

async function readModels(client: ClientApi, signal: AbortSignal) {
  const models = parseSpadeModels(await spadeHttp(client, "GET", "/v1/models", { signal }));
  if (!models) throw new Error("Spade's model list didn't make sense.");
  return models;
}

const roleNames: Record<string, string> = { main: "Main", fast: "Fast", deep: "Deep" };

/**
 * Settings › Spade: on or off and its state, then each model endpoint Spade knows with its
 * models (and which role each serves) and whether its key is set. A key typed here goes to Spade
 * in one request, which keeps it in the OS keychain; the field is cleared as it goes, and the key
 * is never kept anywhere in the app.
 */
export function SpadeSettings() {
  const id = useId();
  const status = useSpadeStatus();
  const [enabled, setEnabled, saving] = useSpadeEnabled();
  const line = spadeStateLine(status, enabled);
  const models = useDaemonQuery({ queryKey: modelsKey, read: readModels, enabled: line.ready });
  return (
    <>
      <SettingSection label="Spade">
        <SettingRow
          title="Run Spade on this machine"
          description={line.sentence}
          htmlFor={id}
          density="compact"
          inline
        >
          <Switch
            id={id}
            checked={enabled === true}
            disabled={enabled === undefined || saving}
            onCheckedChange={(checked) => void setEnabled(checked)}
          />
        </SettingRow>
      </SettingSection>
      {line.ready &&
        (models.isPending ? (
          <ListSkeleton label="models" shape="row" rows={2} />
        ) : models.isError ? (
          <SettingSection label="Models">
            <SettingRow title="Couldn't read Spade's models" description={models.error.message}>
              <Button size="sm" onClick={() => void models.refetch()}>
                Try again
              </Button>
            </SettingRow>
          </SettingSection>
        ) : (
          models.data.endpoints.map((endpoint) => (
            <SettingSection key={endpoint.id} label={endpoint.name}>
              {endpoint.needsKey && <KeyRow endpoint={endpoint} keychain={models.data.keychain} />}
              {endpoint.models.map((model) => {
                const roles = Object.entries(models.data.roles)
                  .filter(([, picked]) => picked === model.id)
                  .map(([role]) => roleNames[role] ?? role);
                return (
                  <SettingRow
                    key={model.id}
                    title={model.name}
                    description={roles.length ? `Spade's ${roles.join(", ")} model` : undefined}
                    density="compact"
                  />
                );
              })}
            </SettingSection>
          ))
        ))}
    </>
  );
}

function KeyRow(props: { endpoint: SpadeEndpoint; keychain: boolean }) {
  const { endpoint } = props;
  const client = useClient();
  const cache = useQueryClient();
  const toast = useToast();
  const field = useId();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const path = `/v1/keys/${segment(endpoint.id)}`;
  const change = async (action: "set" | "remove") => {
    const key = draft.trim();
    // The field empties before the request goes, so the key lives only in this call.
    setDraft("");
    setSending(true);
    try {
      if (action === "set") await spadeHttp(client, "PUT", path, { body: { key } });
      else await spadeHttp(client, "DELETE", path);
      await cache.invalidateQueries({ queryKey: modelsKey });
    } catch (error) {
      toast.error({
        title: action === "set" ? "Couldn't save the key" : "Couldn't remove the key",
        description: error instanceof Error ? error.message : "Try again.",
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
          endpoint.keySet
            ? "Set from the environment."
            : "This machine has no keychain. Set the endpoint's environment variable for Spade."
        }
      />
    );
  return (
    <SettingRow
      title="Key"
      htmlFor={field}
      description={endpoint.keySet ? "Set" : "Not set. Spade can't use these models without it."}
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
        {endpoint.keySet && (
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
