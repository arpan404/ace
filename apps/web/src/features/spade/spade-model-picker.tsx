import { spadeModelFacts, splitSpadeModel, type SpadeEndpoint } from "@ace/ui-core/spade-chat";
import { CaretDownIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Input } from "@/components/ui/input.tsx";
import { menuItem } from "@/components/ui/menu-styles.ts";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { Select, selectTrigger } from "@/components/ui/select.tsx";
import { cn } from "@/lib/cn.ts";
import { useEndpointModels, useSpadeModels } from "./use-spade-models.ts";

/**
 * A bot's model (ADR 0126): one of the person's endpoints, then a model from what that endpoint
 * lists now merged with the ones saved on it, searchable, with its context and capabilities when
 * known; or any model id typed in. `value` is `endpoint/model`.
 */
export function SpadeModelPicker(props: {
  value: string;
  onChange(value: string): void;
  id?: string | undefined;
  /** What the picker is for, when a page has more than one ("Review model"); else "Model". */
  label?: string | undefined;
}) {
  const models = useSpadeModels(true);
  const endpoints = models.data?.endpoints ?? [];
  const chosen = splitSpadeModel(props.value);
  const endpoint = endpoints.find((candidate) => candidate.id === chosen.endpoint) ?? endpoints[0];
  if (models.isPending)
    return <p className="text-ui text-muted-foreground">Reading your endpoints…</p>;
  if (models.isError)
    return (
      <p className="text-ui text-muted-foreground">
        Couldn't read your endpoints. {models.error.message}
      </p>
    );
  if (!endpoint)
    return (
      <p className="text-ui text-muted-foreground">Add an endpoint in Settings › Spade first.</p>
    );
  return (
    <div className="flex min-w-0 gap-2">
      <Select
        label={props.label ? `${props.label.replace(/ model$/, "")} endpoint` : "Endpoint"}
        value={endpoint.id}
        options={endpoints.map((each) => ({ value: each.id, label: each.name }))}
        onValueChange={(next) => props.onChange(`${next}/`)}
        className="w-44 shrink-0"
      />
      <SpadeModelChoice
        key={endpoint.id}
        id={props.id}
        label={props.label}
        endpoint={endpoint}
        model={endpoint.id === chosen.endpoint ? chosen.model : ""}
        onChange={(model) => props.onChange(`${endpoint.id}/${model}`)}
      />
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
  const needsKey = props.endpoint.needsKey && !props.endpoint.keySet;
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
              : live.isError
                ? `Couldn't list its models. ${live.error.message}`
                : "Listing its models…"}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
