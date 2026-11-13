import { spadeMoney, type SpadeOversight } from "@ace/ui-core/spade-chat";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useMemo, useState } from "react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { SpadeModelPicker } from "./spade-model-picker.tsx";
import { oversightKey, readOversight, setOversight } from "./spade-oversight-api.ts";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { useTellZone } from "./use-spade-zone.ts";
import { LoadingRows } from "./spade-settings-loading.tsx";

const fault = (error: unknown) => (error instanceof Error ? error.message : "Try again.");

/**
 * Settings › Spade › Spending and review (ADR 0135): the review default and its model, the
 * service's daily cap (read only) and what every bot spent together, then one line per bot with
 * Each bot's own spend, caps and review are on its page.
 */
export function OversightSettings(props: { ready: boolean }) {
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const cache = useQueryClient();
  const toast = useToast();
  const id = useId();
  useTellZone(useMemo(() => (props.ready ? [client] : []), [client, props.ready]));
  const oversight = useQuery({
    queryKey: [...oversightKey, machine],
    queryFn: ({ signal }) => readOversight(client, signal),
    enabled: props.ready,
  });
  const change = (what: string, next: Parameters<typeof setOversight>[1]) =>
    void setOversight(client, next).then(
      (saved) => cache.setQueryData([...oversightKey, machine], saved),
      (error: unknown) =>
        toast.error({ title: `Couldn't change ${what}`, description: fault(error) }),
    );
  if (oversight.isPending)
    return (
      <SettingSection label="Spending and review" anchor="spending">
        <LoadingRows label="Spending and review" rows={3} />
      </SettingSection>
    );
  if (oversight.isError)
    return (
      <SettingSection label="Spending and review" anchor="spending">
        <SettingRow title="Couldn't read Spade's spending" description={oversight.error.message}>
          <Button size="sm" onClick={() => void oversight.refetch()}>
            Try again
          </Button>
        </SettingRow>
      </SettingSection>
    );
  const data = oversight.data;
  return (
    <SettingSection label="Spending and review" anchor="spending">
      <SettingRow
        title="Review every bot's steps"
        description="A second model checks each step that changes something before it runs, and asks you when it looks wrong. Each bot can follow this or choose for itself."
        htmlFor={id}
        density="compact"
        inline
      >
        <Switch
          id={id}
          checked={data.reviewDefault}
          onCheckedChange={(checked) => change("the review", { review_default: checked })}
        />
      </SettingRow>
      <ReviewModelRow
        oversight={data}
        onChange={(model) => change("the review model", { review_model: model })}
      />
      <SettingRow
        title="Spent"
        description={`${spadeMoney(data.todayMicros)} today · ${spadeMoney(data.monthMicros)} this month, every bot together`}
        density="compact"
      >
        <span className="text-ui text-muted-foreground tabular-nums">
          {data.dailyCapMicros === undefined
            ? "No daily cap"
            : `Daily cap ${spadeMoney(data.dailyCapMicros)}`}
        </span>
      </SettingRow>
    </SettingSection>
  );
}

/** The review model: one of the person's models, or the fast model when none is picked. */
function ReviewModelRow(props: {
  oversight: SpadeOversight;
  onChange(model: string | null): void;
}) {
  const id = useId();
  const saved = props.oversight.reviewModel ?? "";
  // The picker's endpoint may change before a model is chosen; only a whole choice is saved.
  const [draft, setDraft] = useState(saved);
  const [seen, setSeen] = useState(saved);
  if (seen !== saved) {
    setSeen(saved);
    setDraft(saved);
  }
  return (
    <SettingRow
      title="Review model"
      description={
        props.oversight.reviewModel
          ? "Checks the steps of bots with the review on."
          : "None picked: the fast model, else each bot's own."
      }
      htmlFor={id}
      density="compact"
    >
      <div className="flex min-w-0 items-center gap-1">
        <SpadeModelPicker
          id={id}
          label="Review model"
          value={draft}
          onChange={(next) => {
            setDraft(next);
            if (/^[^/]+\/.+/.test(next)) props.onChange(next);
          }}
        />
        {props.oversight.reviewModel && (
          <Button size="sm" variant="ghost" onClick={() => props.onChange(null)}>
            Use the fast model
          </Button>
        )}
      </div>
    </SettingRow>
  );
}
