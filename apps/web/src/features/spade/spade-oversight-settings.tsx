import { spadeMoney, type SpadeOversight } from "@ace/ui-core/spade-chat";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useMemo, useState } from "react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import {
  oversightKey,
  readOversight,
  setOversight,
  type SpadeOversightChange,
} from "./spade-oversight-api.ts";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { useTellZone } from "./use-spade-zone.ts";
import { LoadingRows } from "./spade-settings-loading.tsx";
import { CouldNotRead, fault, Refusal } from "./spade-settings-rows.tsx";

/**
 * Spending and the model review (ADR 0135) as Settings › Spade › General holds them: read once,
 * the person's zone told to Spade, and a change stored in place of what was read.
 */
export function useOversightSettings(ready: boolean) {
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const cache = useQueryClient();
  useTellZone(useMemo(() => (ready ? [client] : []), [client, ready]));
  const oversight = useQuery({
    queryKey: [...oversightKey, machine],
    queryFn: ({ signal }) => readOversight(client, signal),
    enabled: ready,
    // Spend is live: read again while the page shows (react-query skips hidden windows).
    refetchInterval: 30_000,
  });
  const change = async (next: SpadeOversightChange) => {
    const saved = await setOversight(client, next);
    cache.setQueryData([...oversightKey, machine], saved);
  };
  return { oversight, change };
}

type OversightSettings = ReturnType<typeof useOversightSettings>;

/**
 * Whether every bot's steps are reviewed unless its own page says otherwise. The model that
 * reviews them is the Reviewing steps role, in Settings › Spade › Models.
 */
export function ReviewRows(props: { settings: OversightSettings }) {
  const { oversight, change } = props.settings;
  if (!oversight.data) return null;
  return (
    <ReviewDefaultRow
      oversight={oversight.data}
      onChange={(on) => change({ review_default: on })}
    />
  );
}

/** Whether a bot's writes go to the review model by default; each bot can differ on its page. */
function ReviewDefaultRow(props: {
  oversight: SpadeOversight;
  onChange(on: boolean): Promise<unknown>;
}) {
  const id = useId();
  const [refusal, setRefusal] = useState<string>();
  const [saving, setSaving] = useState(false);
  return (
    <SettingRow
      title="Review every bot's writes"
      description={refusal && <Refusal>{refusal}</Refusal>}
      htmlFor={id}
      density="compact"
      inline
    >
      <Switch
        id={id}
        checked={props.oversight.reviewDefault}
        disabled={saving}
        onCheckedChange={(checked) => {
          setSaving(true);
          setRefusal(undefined);
          void props
            .onChange(checked)
            .catch((error: unknown) => setRefusal(fault(error)))
            .finally(() => setSaving(false));
        }}
      />
    </SettingRow>
  );
}

/** What every bot spent together this month and today, read live: information only (ADR 0166). */
export function SpendingSection(props: { settings: OversightSettings }) {
  const { oversight } = props.settings;
  const label = "Spending, every bot together";
  if (oversight.isPending)
    return (
      <SettingSection label={label} anchor="spending">
        <LoadingRows label={label} rows={1} />
      </SettingSection>
    );
  if (oversight.isError)
    return (
      <SettingSection label={label} anchor="spending">
        <CouldNotRead
          what="Spade's spending"
          error={oversight.error}
          retry={() => void oversight.refetch()}
        />
      </SettingSection>
    );
  const data = oversight.data;
  return (
    <SettingSection label={label} anchor="spending">
      <SettingRow
        title="This month"
        description={`${spadeMoney(data.todayMicros)} today`}
        density="compact"
        inline
      >
        <span className="text-ui text-foreground tabular-nums">{spadeMoney(data.monthMicros)}</span>
      </SettingRow>
    </SettingSection>
  );
}
