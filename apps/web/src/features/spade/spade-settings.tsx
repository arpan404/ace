import { spadeStateLine, type SpadeModels } from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { SettingAddRow, SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { AddEndpointDialog } from "./spade-add-endpoint.tsx";
import { ConnectorSettings } from "./spade-connector-settings.tsx";
import { setFastModel } from "./spade-api.ts";
import { EndpointSection } from "./spade-endpoint-settings.tsx";
import { OversightSettings } from "./spade-oversight-settings.tsx";
import { SearchSettings } from "./spade-search-settings.tsx";
import { TranscriptionRow, transcriptionWords } from "./spade-transcription-row.tsx";
import { SpadeNotes } from "./spade-notes.tsx";
import {
  LoadingRow,
  LoadingRows,
  SelectSkeleton,
  SwitchSkeleton,
} from "./spade-settings-loading.tsx";
import { useSpadeEnabled } from "./use-spade-enabled.ts";
import { modelsKey, useSpadeModels } from "./use-spade-models.ts";
import { useSpadeStatus } from "./use-spade-status.ts";
import { useSpadeClient } from "./spade-machine.tsx";

/**
 * Settings › Spade: on or off and its state; the fast model; spending and the model review
 * (ADR 0135); About you, the notes every bot
 * sees (ADR 0128); then each of the person's model endpoints (its key, its saved models,
 * removing it) and Add endpoint, from a preset or custom; then web search's Brave key and
 * SearXNG; then the apps Spade is connected to (ADR 0131). While the setting or Spade's state is
 * still being read, every group stands in place with placeholders, and the switch shows none of
 * on or off until the setting is known.
 */
export function SpadeSettings() {
  const id = useId();
  const status = useSpadeStatus();
  const [enabled, setEnabled, saving] = useSpadeEnabled();
  const line = spadeStateLine(status, enabled);
  const models = useSpadeModels(line.ready);
  const [adding, setAdding] = useState(false);
  // Not known yet whether Spade runs: the groups it would show hold their place.
  const reading = !line.ready && (enabled === undefined || status === undefined);
  const modelsLoading = (line.ready && models.isPending) || reading;
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
          {enabled === undefined ? (
            <SwitchSkeleton />
          ) : (
            <Switch
              id={id}
              checked={enabled}
              disabled={saving}
              onCheckedChange={(checked) => void setEnabled(checked)}
            />
          )}
        </SettingRow>
        {models.data && <FastModelRow models={models.data} />}
        {models.data && <TranscriptionRow models={models.data} />}
        {modelsLoading && !models.data && (
          <>
            <LoadingRow
              title="Fast model"
              description={fastModelWords}
              control={<SelectSkeleton />}
            />
            <LoadingRow
              title="Transcription"
              description={transcriptionWords}
              control={<SelectSkeleton />}
            />
          </>
        )}
      </SettingSection>
      {(line.ready || reading) && <OversightSettings ready={line.ready} />}
      {(line.ready || reading) && (
        <SettingSection label="About you" anchor="about-you">
          {line.ready ? (
            <SpadeNotes
              scope={{ kind: "shared" }}
              label="About you"
              placeholder="Add something about you"
            />
          ) : (
            <LoadingRows label="About you" rows={2} />
          )}
        </SettingSection>
      )}
      {(line.ready || reading) &&
        (!models.data && !models.isError ? (
          <SettingSection label="Endpoints">
            <LoadingRows label="Endpoints" rows={2} />
          </SettingSection>
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
      {(line.ready || reading) && <SearchSettings ready={line.ready} />}
      {(line.ready || reading) && <ConnectorSettings ready={line.ready} />}
    </>
  );
}

const fastModelWords = "Used for titles and other small jobs; defaults to each agent's own model.";

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
    <SettingRow title="Fast model" description={fastModelWords} htmlFor={id} density="compact">
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
