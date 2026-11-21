import {
  mergeSpadeModels,
  spadeLocalChoices,
  spadeSubscriptionSources,
  type SpadeEndpoint,
} from "@ace/ui-core/spade-chat";
import { CaretDownIcon, CheckIcon } from "@ace/icons";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { Input } from "@/components/ui/input.tsx";
import { menuItem, menuLabel } from "@/components/ui/menu-styles.ts";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { selectTrigger } from "@/components/ui/select.tsx";
import { useListHighlight } from "@/components/ui/use-list-highlight.ts";
import { cn } from "@/lib/cn.ts";
import { acknowledgeTerms, pickLocalModel, readLiveModels } from "./spade-api.ts";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import {
  spadeModelGroups,
  spadeModelLabel,
  type SpadeModelOption,
  type SpadeModelSources,
} from "./spade-model-options.ts";
import {
  modelsKey,
  useEndpointModels,
  useLocalServers,
  useSpadeModels,
  useSpadeSubscriptions,
} from "./use-spade-models.ts";

/**
 * A model (ADR 0126, 0133, 0205), picked in one control: a button reading "Claude Sonnet 5.5 ·
 * OpenRouter" that opens every model of the person's endpoints (those on this computer first),
 * the models of local servers not added yet, and, where a bot's own model is picked
 * (`subscriptions`), their coding subscriptions last. Grouped by where each comes from,
 * searchable, and any id typed in for an endpoint. An endpoint's models are what it lists now
 * merged with the saved ones. Picking a subscription whose terms the person hasn't acknowledged
 * shows what it means first; they tick Use it. `value` is `endpoint/model`,
 * `cli:<provider>@<account>/<model>`, or "" for the empty choice `none` names ("Each bot's
 * own"), which `onChange` reports as "".
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
  /** Offer the person's coding subscriptions: only where a bot's own model is picked. */
  subscriptions?: boolean | undefined;
  className?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState<SpadeModelOption>();
  const sources = useModelSources(open, props.subscriptions === true);
  const client = useSpadeClient();
  const cache = useQueryClient();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const done = (value: string) => {
    props.onChange(value);
    setOpen(false);
    setAsking(undefined);
  };
  const pick = async (option: SpadeModelOption) => {
    setProblem(undefined);
    if (option.acknowledge) {
      setAsking(option);
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
      done(value);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Try again.");
    } finally {
      setBusy(false);
    }
  };
  const useIt = async (option: SpadeModelOption) => {
    if (!option.acknowledge) return;
    setProblem(undefined);
    setBusy(true);
    try {
      await acknowledgeTerms(client, option.acknowledge.provider);
      await cache.invalidateQueries({ queryKey: modelsKey });
      done(option.value);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Try again.");
    } finally {
      setBusy(false);
    }
  };
  const shown =
    !props.value && props.follows
      ? spadeModelLabel(sources, props.follows)
      : spadeModelLabel(sources, props.value, props.none);
  const followsName = props.follows ? spadeModelLabel(sources, props.follows).name : undefined;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setAsking(undefined);
      }}
    >
      <PopoverTrigger
        id={props.id}
        aria-label={props.label ?? "Model"}
        className={cn(
          selectTrigger,
          "w-72 max-w-full min-w-0 @max-[440px]:w-full",
          props.className,
        )}
      >
        <span className="min-w-0 flex-1 truncate text-left">
          {shown.name}
          {shown.source && <span className="text-muted-foreground">{` · ${shown.source}`}</span>}
        </span>
        <CaretDownIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-(--anchor-width) min-w-96 p-1" aria-label="Models">
        {asking?.acknowledge ? (
          <UseSubscription
            option={asking}
            busy={busy}
            onUse={() => void useIt(asking)}
            onBack={() => setAsking(undefined)}
          />
        ) : (
          <ModelList
            sources={sources}
            value={props.value}
            none={props.none}
            noneFacts={followsName}
            disabled={busy}
            onPick={(option) => void pick(option)}
          />
        )}
        {problem && <p className="px-2 py-1 text-xs text-destructive">{problem}</p>}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Every endpoint with its models, the local servers' models not added yet, and (with
 * `withSubscriptions`) every subscription. Endpoints and local servers are looked at live only
 * while the list is open (`live`), and an endpoint never while its key isn't known.
 */
function useModelSources(live: boolean, withSubscriptions: boolean): SpadeModelSources {
  const machine = useSpadeMachine().key;
  const client = useSpadeClient();
  const models = useSpadeModels(true);
  const subscriptions = useSpadeSubscriptions(withSubscriptions);
  const local = useLocalServers(live);
  const endpoints = models.data?.endpoints ?? [];
  const lists = useQueries({
    queries: endpoints.map((endpoint) => ({
      // The same entry `useEndpointModels` reads, so a list read in one place serves both.
      queryKey: [...modelsKey, machine, "live", endpoint.id],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        readLiveModels(client, endpoint.id, { signal }),
      enabled: live && (!endpoint.needsKey || endpoint.keySet === true),
      staleTime: 60_000,
      retry: false,
    })),
  });
  return {
    endpoints: endpoints.map((endpoint, at) => ({
      endpoint,
      models: mergeSpadeModels(endpoint.models, lists[at]?.data),
    })),
    adds: spadeLocalChoices(local.data ?? []).map(({ server, model }) => ({
      server: { id: server.id, name: server.name },
      model,
    })),
    subscriptions: withSubscriptions
      ? spadeSubscriptionSources(subscriptions.data?.providers ?? [])
      : [],
  };
}

/**
 * What choosing a subscription for a bot means (ADR 0205 §1), once per provider: its words, and
 * the person ticks Use it. Back returns to the list.
 */
function UseSubscription(props: {
  option: SpadeModelOption;
  busy: boolean;
  onUse(): void;
  onBack(): void;
}) {
  const id = useId();
  return (
    <div
      role="group"
      aria-label={`Use ${props.option.source ?? "this subscription"}`}
      className="p-2"
    >
      <p className="text-ui text-foreground">{props.option.acknowledge?.text}</p>
      <div className="mt-3 flex items-center justify-between gap-2">
        <label htmlFor={id} className="flex items-center gap-2 text-ui">
          <Checkbox
            id={id}
            checked={false}
            disabled={props.busy}
            onCheckedChange={(checked) => {
              if (checked) props.onUse();
            }}
          />
          Use it
        </label>
        <Button size="sm" variant="ghost" onClick={props.onBack}>
          Back
        </Button>
      </div>
    </div>
  );
}

/** The open list: a search field over the groups, the arrow keys moving through them. */
function ModelList(props: {
  sources: SpadeModelSources;
  value: string;
  none: string | undefined;
  /** Beside the empty choice: what it comes to. */
  noneFacts?: string | undefined;
  disabled?: boolean | undefined;
  onPick(option: SpadeModelOption): void;
}) {
  const [query, setQuery] = useState("");
  const groups = spadeModelGroups(props.sources, query, props.none, props.noneFacts);
  const flat = groups.flatMap((group) => group.options);
  const list = useListHighlight({ count: flat.length });
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const action = list.key(event, () => true);
    if (action.kind === "pick") {
      event.preventDefault();
      const option = flat[action.at];
      if (option && !props.disabled) props.onPick(option);
    } else if (action.kind === "pass" && event.key === "Enter") {
      event.preventDefault();
      const first = flat[0];
      if (first && !props.disabled) props.onPick(first);
    }
  };
  const nothing =
    props.sources.endpoints.length === 0 &&
    !props.sources.adds?.length &&
    props.sources.subscriptions.length === 0;
  // Where each group's first option sits in the flat list the keys move through.
  const starts = groups.map((_, index) =>
    groups.slice(0, index).reduce((sum, group) => sum + group.options.length, 0),
  );
  return (
    <>
      <Input
        role="combobox"
        aria-label="Search models"
        aria-expanded
        aria-controls={list.listId}
        aria-activedescendant={list.current === undefined ? undefined : list.optionId(list.current)}
        placeholder="Search or type a model id"
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- the list opens to its search.
        autoFocus
        spellCheck={false}
        autoComplete="off"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          list.reset();
        }}
        onKeyDown={onKeyDown}
        className="mb-1"
      />
      <div
        id={list.listId}
        role="listbox"
        aria-label="Models"
        onPointerLeave={list.leave}
        className="no-scrollbar max-h-72 overflow-y-auto"
      >
        {groups.map((group, groupAt) => (
          <div key={group.label ?? ""} role="group" aria-label={group.label ?? props.none}>
            {group.heading && (
              <div className={cn(menuLabel, "mt-1 border-t border-border pt-2 text-foreground")}>
                {group.heading}
              </div>
            )}
            {group.label && <div className={cn(menuLabel, "pt-2")}>{group.label}</div>}
            {group.options.map((option, optionAt) => {
              const index = (starts[groupAt] ?? 0) + optionAt;
              return (
                <ModelOption
                  key={option.value || "none"}
                  id={list.optionId(index)}
                  option={option}
                  chosen={option.value === props.value && !option.typed}
                  active={list.current === index}
                  onPoint={() => list.point(index)}
                  onPick={() => {
                    if (!props.disabled) props.onPick(option);
                  }}
                />
              );
            })}
          </div>
        ))}
        {nothing && (
          <p className="px-2 py-1.5 text-ui text-muted-foreground">
            Add an endpoint in Models first.
          </p>
        )}
        {!nothing && flat.length === 0 && (
          <p className="px-2 py-1.5 text-ui text-muted-foreground">No model matches.</p>
        )}
      </div>
    </>
  );
}

function ModelOption(props: {
  id: string;
  option: SpadeModelOption;
  chosen: boolean;
  active: boolean;
  onPoint(): void;
  onPick(): void;
}) {
  const { option } = props;
  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- keys pick through the combobox's aria-activedescendant
    <div
      id={props.id}
      role="option"
      aria-selected={props.chosen}
      tabIndex={-1}
      onPointerMove={props.active ? undefined : props.onPoint}
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onPick}
      className={cn(menuItem, props.active && "bg-accent")}
    >
      <span className="max-w-[70%] shrink-0 truncate">{option.name}</span>
      <span className="min-w-0 flex-1 truncate text-right text-xs text-subtle-foreground">
        {option.facts}
      </span>
      <CheckIcon aria-hidden size={14} className={cn(!props.chosen && "invisible")} />
    </div>
  );
}

/**
 * A model from one endpoint, where the endpoint is already chosen (first-run setup, Add a model):
 * its live list merged with saved ones, from the same read the chat's picker makes, searchable,
 * or a typed id. `omit` leaves out ids already there (the endpoint's saved models).
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
  const models = props.omit
    ? listed.models.filter((model) => !props.omit?.includes(model.id))
    : listed.models;
  const sources: SpadeModelSources = {
    endpoints: [{ endpoint: props.endpoint, models }],
    subscriptions: [],
  };
  const value = props.model ? `${props.endpoint.id}/${props.model}` : "";
  const current = models.find((model) => model.id === props.model);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        id={props.id}
        aria-label={props.label ?? "Model"}
        className={cn(selectTrigger, "w-72 max-w-full min-w-0 @max-[440px]:w-full")}
      >
        <span className="min-w-0 flex-1 truncate text-left">
          {current?.name ?? (props.model || "Choose a model")}
        </span>
        <CaretDownIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-(--anchor-width) min-w-96 p-1" aria-label="Models">
        <ModelList
          sources={sources}
          value={value}
          none={undefined}
          onPick={(picked) => {
            props.onChange(picked.value.slice(props.endpoint.id.length + 1));
            setOpen(false);
          }}
        />
        {live.isError && (
          <p className="px-2 pt-1 pb-0.5 text-xs text-subtle-foreground">
            {`Couldn't list its models. ${live.error.message}`}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
