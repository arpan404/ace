import {
  cliSourceKey,
  spadeModelFacts,
  spadeSubscriptionSources,
  splitCliModel,
  splitSpadeModel,
  type SpadeEndpoint,
} from "@ace/ui-core/spade-chat";
import { CaretDownIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Input } from "@/components/ui/input.tsx";
import { menuItem } from "@/components/ui/menu-styles.ts";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { Select, selectTrigger } from "@/components/ui/select.tsx";
import { cn } from "@/lib/cn.ts";
import { useEndpointModels, useSpadeModels, useSpadeSubscriptions } from "./use-spade-models.ts";

/**
 * A bot's model (ADR 0126, 0133): one of the person's endpoints or, under "Your subscriptions",
 * one account of a provider CLI ace runs for them; then a model from that source. An endpoint's
 * models are what it lists now merged with the saved ones, searchable, or any id typed in; a
 * subscription's are what ace lists. `value` is `endpoint/model` or
 * `cli:<provider>@<account>/<model>`.
 */
export function SpadeModelPicker(props: {
  value: string;
  onChange(value: string): void;
  id?: string | undefined;
  /** What the picker is for, when a page has more than one ("Review model"); else "Model". */
  label?: string | undefined;
}) {
  const models = useSpadeModels(true);
  const subscriptions = useSpadeSubscriptions(true);
  const endpoints = models.data?.endpoints ?? [];
  const sources = spadeSubscriptionSources(subscriptions.data?.providers ?? []);
  const chosenCli = splitCliModel(props.value);
  const cliKey = cliSourceKey(props.value, sources);
  const chosen = splitSpadeModel(props.value);
  const endpoint = chosenCli
    ? undefined
    : (endpoints.find((candidate) => candidate.id === chosen.endpoint) ?? endpoints[0]);
  const source = chosenCli ? sources.find((each) => each.key === cliKey) : undefined;
  if (models.isPending)
    return <p className="text-ui text-muted-foreground">Reading your endpoints…</p>;
  if (models.isError)
    return (
      <p className="text-ui text-muted-foreground">
        Couldn't read your endpoints. {models.error.message}
      </p>
    );
  if (!endpoint && !source && !chosenCli && sources.length === 0)
    return (
      <p className="text-ui text-muted-foreground">Add an endpoint in Settings › Spade first.</p>
    );
  const current = endpoint?.id ?? cliKey ?? (chosenCli ? props.value : "");
  const options = [
    ...endpoints.map((each) => ({ value: each.id, label: each.name })),
    ...sources.map((each) => ({
      value: each.key,
      label: each.label,
      group: "Your subscriptions",
    })),
    // A subscription the bot is on that ace doesn't list now (signed out, uninstalled).
    ...(chosenCli && !cliKey
      ? [{ value: current, label: chosenCli.provider, group: "Your subscriptions" }]
      : []),
  ];
  const pickSource = (next: string) => {
    const subscription = sources.find((each) => each.key === next);
    if (subscription) props.onChange(`${subscription.key}/${subscription.models[0]?.id ?? ""}`);
    else props.onChange(`${next}/`);
  };
  return (
    <div className="flex min-w-0 gap-2">
      <Select
        label={props.label ? `${props.label.replace(/ model$/, "")} endpoint` : "Endpoint"}
        value={current}
        options={options}
        onValueChange={pickSource}
        className="w-44 shrink-0"
      />
      {endpoint ? (
        <SpadeModelChoice
          key={endpoint.id}
          id={props.id}
          label={props.label}
          endpoint={endpoint}
          model={endpoint.id === chosen.endpoint ? chosen.model : ""}
          onChange={(model) => props.onChange(`${endpoint.id}/${model}`)}
        />
      ) : source ? (
        <Select
          id={props.id}
          label={props.label ?? "Model"}
          value={chosenCli?.model ?? ""}
          options={[
            ...source.models.map((model) => ({ value: model.id, label: model.name })),
            ...(chosenCli && !source.models.some((model) => model.id === chosenCli.model)
              ? [{ value: chosenCli.model, label: chosenCli.model }]
              : []),
          ]}
          onValueChange={(model) => props.onChange(`${source.key}/${model}`)}
          className="min-w-0 flex-1"
        />
      ) : (
        <p className="min-w-0 flex-1 self-center truncate text-ui text-muted-foreground">
          {subscriptions.data?.error
            ? "ace isn't reachable, so your subscriptions can't be listed."
            : "ace doesn't list this subscription now."}
        </p>
      )}
    </div>
  );
}

/** A model from one endpoint: its live list merged with saved ones, searchable, or a typed id. */
export function SpadeModelChoice(props: {
  endpoint: SpadeEndpoint;
  model: string;
  id?: string | undefined;
  label?: string | undefined;
  onChange(model: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { models, live } = useEndpointModels(props.endpoint);
  const typed = query.trim();
  const shown = typed
    ? models.filter((model) =>
        `${model.name} ${model.id}`.toLowerCase().includes(typed.toLowerCase()),
      )
    : models;
  const current = models.find((model) => model.id === props.model);
  const pick = (model: string) => {
    props.onChange(model);
    setOpen(false);
    setQuery("");
  };
  const needsKey = props.endpoint.needsKey && props.endpoint.keySet === false;
  const checkingKey = props.endpoint.needsKey && props.endpoint.keySet === undefined;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        id={props.id}
        aria-label={props.label ?? "Model"}
        className={cn(selectTrigger, "min-w-0 flex-1")}
      >
        <span className="truncate">{current?.name ?? (props.model || "Choose a model")}</span>
        <CaretDownIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
      </PopoverTrigger>
      <PopoverContent className="w-(--anchor-width) min-w-72 p-1" aria-label="Models">
        <Input
          aria-label="Search models"
          placeholder="Search or type a model id"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            const first = shown[0];
            if (typed && !shown.some((model) => model.id === typed)) pick(typed);
            else if (first) pick(first.id);
          }}
          className="mb-1"
        />
        <div role="listbox" aria-label="Models" className="no-scrollbar max-h-64 overflow-y-auto">
          {shown.map((model) => (
            <button
              key={model.id}
              type="button"
              role="option"
              aria-selected={model.id === props.model}
              onClick={() => pick(model.id)}
              className={cn(menuItem, "w-full", model.id === props.model && "bg-active")}
            >
              <span className="min-w-0 flex-1 truncate text-left">{model.name}</span>
              <span className="shrink-0 text-xs text-subtle-foreground">
                {spadeModelFacts(model)}
              </span>
            </button>
          ))}
          {typed && !models.some((model) => model.id === typed) && (
            <button
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => pick(typed)}
              className={cn(menuItem, "w-full")}
            >
              <span className="min-w-0 flex-1 truncate text-left">{`Use “${typed}” as the model id`}</span>
            </button>
          )}
        </div>
        {/* How the endpoint's own list went, in one line, only when it didn't simply arrive. */}
        {(needsKey || live.isPending || live.isError) && (
          <p className="px-2 pt-1 pb-0.5 text-xs text-subtle-foreground">
            {needsKey
              ? "Add this endpoint's key to see what it lists."
              : checkingKey
                ? "Checking this endpoint's key…"
                : live.isError
                  ? `Couldn't list its models. ${live.error.message}`
                  : "Listing its models…"}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
