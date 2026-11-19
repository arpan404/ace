import { useState } from "react";
import { SettingAddRow, SettingCard, settingsGroup } from "@/components/setting-row.tsx";
import { AddEndpointDialog } from "./spade-add-endpoint.tsx";
import { EndpointSection } from "./spade-endpoint-settings.tsx";
import { LoadingRows } from "./spade-settings-loading.tsx";
import { GlobalRoles } from "./spade-settings-roles.tsx";
import { CouldNotRead, SpadeNotRunning, useSpadeRunning } from "./spade-settings-rows.tsx";
import { useSpadeModels } from "./use-spade-models.ts";

/**
 * Settings › Spade › Models, in the order setup goes: each of the person's endpoints (its
 * address, key and models), then Add an endpoint, from a preset or by address, then the models
 * for every bot's other work (helpers, checking done, reviewing steps, summaries, titles), which
 * pick from those endpoints.
 */
export function SpadeModelsSettings() {
  const { line, reading } = useSpadeRunning();
  const models = useSpadeModels(line.ready);
  const [adding, setAdding] = useState(false);
  if (!line.ready && !reading)
    return <SpadeNotRunning sentence={line.sentence} canTurnOn={line.canTurnOn} />;
  if (!models.data)
    return (
      <div className={settingsGroup}>
        <SettingCard>
          {models.isError ? (
            <CouldNotRead
              what="Spade's endpoints"
              error={models.error}
              retry={() => void models.refetch()}
            />
          ) : (
            <LoadingRows label="Endpoints" rows={3} />
          )}
        </SettingCard>
      </div>
    );
  const { data } = models;
  return (
    <>
      {data.endpoints.map((endpoint) => (
        <EndpointSection key={endpoint.id} endpoint={endpoint} keychain={data.keychain} />
      ))}
      <div className={settingsGroup}>
        <SettingCard>
          <SettingAddRow onClick={() => setAdding(true)}>Add an endpoint</SettingAddRow>
        </SettingCard>
      </div>
      <GlobalRoles fastModel={data.fastModel} />
      {adding && <AddEndpointDialog presets={data.presets} onClose={() => setAdding(false)} />}
    </>
  );
}
