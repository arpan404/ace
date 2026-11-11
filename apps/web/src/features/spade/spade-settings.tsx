import { spadeStateLine, type SpadeModels } from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { SettingAddRow, SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { AddEndpointDialog } from "./spade-add-endpoint.tsx";
import { setFastModel } from "./spade-api.ts";
import { EndpointSection } from "./spade-endpoint-settings.tsx";
import { useSpadeEnabled } from "./use-spade-enabled.ts";
import { modelsKey, useSpadeModels } from "./use-spade-models.ts";
import { useSpadeStatus } from "./use-spade-status.ts";
import { useSpadeClient } from "./spade-machine.tsx";

/**
 * Settings › Spade: on or off and its state; the fast model; then each of the person's model
 * endpoints (its key, its saved models, removing it) and Add endpoint, from a preset or custom.
 */
export function SpadeSettings() {
  const id = useId();
  const status = useSpadeStatus();
  const [enabled, setEnabled, saving] = useSpadeEnabled();
  const line = spadeStateLine(status, enabled);
  const models = useSpadeModels(line.ready);
  const [adding, setAdding] = useState(false);
  return (
    <>
      <SettingSection label="Assistant">
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
        {models.data && <FastModelRow models={models.data} />}
      </SettingSection>
      {line.ready &&
        (models.isPending ? (
          <ListSkeleton label="endpoints" shape="row" rows={2} />
        ) : models.isError ? (
          <SettingSection label="Endpoints">
            <SettingRow title="Couldn't read Spade's endpoints" description={models.error.message}>
              <Button size="sm" onClick={() => void models.refetch()}>
                Try again
              </Button>
            </SettingRow>
          </SettingSection>
        ) : (
          <>
            {models.data.endpoints.map((endpoint) => (
              <EndpointSection
                key={endpoint.id}
                endpoint={endpoint}
                keychain={models.data.keychain}
              />
            ))}
            <SettingSection label="Endpoints">
              <SettingAddRow onClick={() => setAdding(true)}>Add endpoint</SettingAddRow>
            </SettingSection>
            {adding && (
              <AddEndpointDialog presets={models.data.presets} onClose={() => setAdding(false)} />
            )}
          </>
        ))}
    </>
  );
}

/** The select's value for "no fast model": each bot uses its own. */
const ownModel = "own";

/** The fast model: titles and other small jobs; each bot's own model when none is set. */
function FastModelRow(props: { models: SpadeModels }) {
  const client = useSpadeClient();
  const cache = useQueryClient();
  const toast = useToast();
  const id = useId();
  const current = props.models.fastModel ?? ownModel;
  const options = [
    { value: ownModel, label: "Each bot's own" },
    ...props.models.endpoints.flatMap((endpoint) =>
      endpoint.models.map((model) => ({
        value: `${endpoint.id}/${model.id}`,
        label: `${model.name} · ${endpoint.name}`,
      })),
    ),
  ];
  if (!options.some((option) => option.value === current))
    options.push({ value: current, label: current });
  return (
    <SettingRow
      title="Fast model"
      description="Used for titles and other small jobs; defaults to each agent's own model."
      htmlFor={id}
      density="compact"
    >
      <Select
        id={id}
        label="Fast model"
        value={current}
        options={options}
        onValueChange={(next) =>
          void setFastModel(client, next === ownModel ? null : next).then(
            () => cache.invalidateQueries({ queryKey: modelsKey }),
            (error: unknown) =>
              toast.error({
                title: "Couldn't change the fast model",
                description: error instanceof Error ? error.message : "Try again.",
              }),
          )
        }
        className="w-56"
      />
    </SettingRow>
  );
}
