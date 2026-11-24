import {
  mergeSpadeModels,
  spadeChecking,
  spadeEndpointUsable,
  spadeLocalChoices,
  spadeModelLabel,
  spadeWaitForChecks,
  splitSpadeModel,
  type SpadeEndpoint,
  type SpadeModelOption,
  type SpadeModelSources,
} from "@ace/ui-core/spade-chat";
import { CaretDownIcon } from "@ace/icons";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { selectTrigger } from "@/components/ui/select.tsx";
import { cn } from "@/lib/cn.ts";
import { part } from "@/lib/suit-part.ts";
import { useNow } from "@/lib/time.ts";
import { pickLocalModel, readLiveModels, readModels } from "./spade-api.ts";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { SpadeModelMark } from "./spade-marks.tsx";
import { SpadeModelPickerPanel } from "./spade-model-picker-panel.tsx";
import {
  modelsKey,
  useEndpointModels,
  useLocalServers,
  useSpadeModels,
} from "./use-spade-models.ts";

/**
 * A model (ADR 0126, 0205), picked in ace's main model picker style: a select-styled trigger
 * carrying the model's mark and name ("Claude Sonnet 5.5 · OpenRouter") that opens a panel with
 * a left vertical rail of Favorites and each account, integrated search and refresh, and two-line
 * model rows. `value` is `endpoint/model`, or "" for the empty choice `none` names.
 */
export function SpadeModelPicker(props: {
  value: string;
  onChange(value: string): void;
  id?: string | undefined;
  /** What the picker is for, when a page has more than one ("Review model"); else "Model". */
  label?: string | undefined;
  /** The words of the empty choice, when the setting has one. */
  none?: string | undefined;
  /**
   * The model the empty choice comes to (a role following Settings): shown in place of `none`
   * while it is chosen, and beside it in the list.
   */
  follows?: string | undefined;
  /**
   * The model runs a bot or tool work (a bot's own, helper-level roles): a local model whose
   * checks found it can't call tools is shown with why, and can't be picked.
   */
  forBots?: boolean | undefined;
  className?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const forBots = props.forBots === true;
  const { sources, keychain, refreshing, refresh } = useModelSources(open, forBots);
  const client = useSpadeClient();
  const cache = useQueryClient();
  const now = useNow();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const done = (value: string) => {
    props.onChange(value);
    setOpen(false);
  };
  const machine = useSpadeMachine().key;
  // A local model just added: its checks run before a bot may think with it.
  const [checking, setChecking] = useState(false);
  const checksOf = async (value: string) => {
    setChecking(true);
    try {
      return await spadeWaitForChecks(value, () =>
        cache.fetchQuery({
          queryKey: [...modelsKey, machine],
          queryFn: ({ signal }) => readModels(client, { signal }),
          staleTime: 0,
        }),
      );
    } finally {
      setChecking(false);
    }
  };
  const pick = async (option: SpadeModelOption) => {
    setProblem(undefined);
    if (option.cant) {
      setProblem(option.cant);
      return;
    }
    if (!option.adds) {
      done(option.value);
      return;
    }
    setBusy(true);
    try {
      const value = await pickLocalModel(client, option.adds.server, option.adds.model);
      await cache.invalidateQueries({ queryKey: modelsKey });
      const cant = forBots ? await checksOf(value) : undefined;
      if (cant) setProblem(cant);
      else done(value);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Try again.");
    } finally {
      setBusy(false);
    }
  };
  const effectiveValue = !props.value && props.follows ? props.follows : props.value;
  const shown =
    !props.value && props.follows
      ? spadeModelLabel(sources, props.follows)
      : spadeModelLabel(sources, props.value, props.none);
  const followsName = props.follows ? spadeModelLabel(sources, props.follows).name : undefined;
  const effectiveParts = effectiveValue ? splitSpadeModel(effectiveValue) : undefined;
  const effectiveEndpoint = effectiveParts
    ? sources.endpoints.find((each) => each.endpoint.id === effectiveParts.endpoint)?.endpoint
    : undefined;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        id={props.id}
        data-slot={props.className ? undefined : "select"}
        {...part("select", undefined, "model")}
        aria-label={props.label ?? "Model"}
        className={cn(
          selectTrigger,
          "w-64 max-w-full min-w-0 @max-[440px]:w-full",
          props.className,
        )}
      >
        <span className="inline-flex min-w-0 flex-1 items-center gap-2 text-left">
          {effectiveEndpoint && effectiveParts && (
            <SpadeModelMark
              model={{ id: effectiveParts.model, name: shown.name }}
              account={effectiveEndpoint}
              size={14}
              className="shrink-0"
              decorative
            />
          )}
          <span className="min-w-0 flex-1 truncate">
            {shown.name}
            {shown.source && <span className="text-muted-foreground">{` · ${shown.source}`}</span>}
          </span>
        </span>
        <CaretDownIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
      </PopoverTrigger>
      <PopoverContent align="end" className="overflow-hidden p-0" aria-label="Models">
        <SpadeModelPickerPanel
          sources={sources}
          value={props.value}
          keychain={keychain}
          now={now}
          none={props.none}
          noneFacts={followsName}
          refreshing={refreshing}
          disabled={busy}
          onRefresh={refresh}
          onPick={(option) => void pick(option)}
          onClose={() => setOpen(false)}
        />
        {checking && (
          <p className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
            {spadeChecking}
          </p>
        )}
        {problem && (
          <p className="border-t border-border px-3 py-1.5 text-xs text-destructive">{problem}</p>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Every endpoint with its models and the local servers' models not added yet. Endpoints and
 * local servers are looked at live only while the list is open (`live`), and an endpoint never
 * while its key isn't known.
 */
function useModelSources(
  live: boolean,
  forBots: boolean,
): {
  sources: SpadeModelSources;
  keychain: boolean;
  refreshing: boolean;
  refresh(): void;
} {
  const machine = useSpadeMachine().key;
  const client = useSpadeClient();
  const cache = useQueryClient();
  const models = useSpadeModels(true);
  const local = useLocalServers(live);
  const endpoints = models.data?.endpoints ?? [];
  const lists = useQueries({
    queries: endpoints.map((endpoint) => ({
      // The same entry `useEndpointModels` reads, so a list read in one place serves both.
      queryKey: [...modelsKey, machine, "live", endpoint.id],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        readLiveModels(client, endpoint.id, { signal }),
      enabled: live && spadeEndpointUsable(endpoint),
      staleTime: 60_000,
      retry: false,
    })),
  });
  const refreshing =
    models.isFetching || local.isFetching || lists.some((query) => query.isFetching);
  const refresh = () => {
    void cache.invalidateQueries({ queryKey: [...modelsKey, machine] });
    void local.refetch();
  };
  return {
    sources: {
      endpoints: endpoints.map((endpoint, at) => ({
        endpoint,
        models: mergeSpadeModels(endpoint.models, lists[at]?.data),
      })),
      adds: spadeLocalChoices(local.data ?? []).map(({ server, model }) => ({
        server: { id: server.id, name: server.name },
        model,
      })),
      forBots,
    },
    keychain: models.data?.keychain ?? true,
    refreshing,
    refresh,
  };
}

/**
 * A model from one endpoint, where the endpoint is already chosen (first-run setup, Add a model):
 * its live list merged with saved ones, searchable, or a typed id, in ace's single-provider
 * model picker style (without the left rail).
 */
export function SpadeModelChoice(props: {
  endpoint: SpadeEndpoint;
  model: string;
  id?: string | undefined;
  label?: string | undefined;
  omit?: readonly string[] | undefined;
  /** Open at once, when the person asked for the list. */
  opened?: boolean | undefined;
  onChange(model: string): void;
}) {
  const [open, setOpen] = useState(props.opened === true);
  const listed = useEndpointModels(props.endpoint);
  const { live } = listed;
  const now = useNow();
  const models = props.omit
    ? listed.models.filter((model) => !props.omit?.includes(model.id))
    : listed.models;
  const sources: SpadeModelSources = {
    endpoints: [{ endpoint: props.endpoint, models }],
  };
  const value = props.model ? `${props.endpoint.id}/${props.model}` : "";
  const current = models.find((model) => model.id === props.model);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        id={props.id}
        data-slot="select"
        {...part("select", undefined, "model")}
        aria-label={props.label ?? "Model"}
        className={cn(selectTrigger, "w-64 max-w-full min-w-0 @max-[440px]:w-full")}
      >
        <span className="inline-flex min-w-0 flex-1 items-center gap-2 text-left">
          {props.model && (
            <SpadeModelMark
              model={{ id: props.model, name: current?.name ?? props.model }}
              account={props.endpoint}
              size={14}
              className="shrink-0"
              decorative
            />
          )}
          <span className="min-w-0 flex-1 truncate">
            {current?.name ?? (props.model || "Choose a model")}
          </span>
        </span>
        <CaretDownIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
      </PopoverTrigger>
      <PopoverContent align="end" className="overflow-hidden p-0" aria-label="Models">
        <SpadeModelPickerPanel
          sources={sources}
          value={value}
          keychain
          now={now}
          none={undefined}
          only
          refreshing={live.isFetching}
          onRefresh={() => void live.refetch()}
          onPick={(picked) => {
            props.onChange(picked.value.slice(props.endpoint.id.length + 1));
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
        {live.isError && (
          <p className="border-t border-border px-3 py-1.5 text-xs text-subtle-foreground">
            {`Couldn't list its models. ${live.error.message}`}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
