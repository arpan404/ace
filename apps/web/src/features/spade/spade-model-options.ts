import {
  spadeLocalFirst,
  spadeModelFacts,
  splitCliModel,
  splitSpadeModel,
  type SpadeEndpoint,
  type SpadeModelInfo,
  type SpadeSubscriptionSource,
} from "@ace/ui-core/spade-chat";

/*
 * What the one model picker offers, as plain data, in the order Spade offers models (ADR 0205
 * §1): models on this computer, the person's other endpoints, local servers' models not added
 * yet, then (only where a bot's own model is picked) their coding subscriptions, last, under
 * their own heading. Grouped by where each comes from and narrowed by what the person typed.
 * Pure, so the picker only draws it.
 */

/** The heading over the subscriptions, which are never picked by themselves. */
export const subscriptionsHeading = "Your coding subscriptions";

export interface SpadeModelOption {
  /** `endpoint/model`, `cli:<provider>@<account>/<model>`, or "" for the picker's empty choice. */
  value: string;
  name: string;
  /** The endpoint or subscription it comes from; undefined for the empty choice. */
  source: string | undefined;
  facts: string;
  /** "Use … as the model id": a typed id the endpoint didn't list. */
  typed?: boolean;
  /** A local server's model not added yet: picking it adds the server first. */
  adds?: { server: string; model: string };
  /** A subscription whose terms the person hasn't acknowledged: they read this and tick Use it. */
  acknowledge?: { provider: string; text: string };
}

export interface SpadeModelGroup {
  /** The group's label; undefined for the empty choice, above every group. */
  label: string | undefined;
  /** A heading over this group and the ones after it (the subscriptions'). */
  heading?: string;
  options: SpadeModelOption[];
}

export interface SpadeModelSources {
  /** Each endpoint with the models it offers now (saved and live, merged). */
  endpoints: readonly { endpoint: SpadeEndpoint; models: readonly SpadeModelInfo[] }[];
  /** Models of servers running on this computer that aren't added yet. */
  adds?: readonly { server: { id: string; name: string }; model: string }[];
  /** Empty where only an endpoint's model may be picked (a role, a default). */
  subscriptions: readonly SpadeSubscriptionSource[];
}

const matches = (query: string, ...words: string[]) =>
  words.join(" ").toLowerCase().includes(query.toLowerCase());

/**
 * The picker's groups for `query`: the empty choice when there is one (`none`), then one group
 * per endpoint (those on this computer first), then the local servers' models not added yet,
 * then one group per subscription under "Your coding subscriptions". A typed id no endpoint
 * lists is offered on each endpoint, last in its group.
 */
export function spadeModelGroups(
  sources: SpadeModelSources,
  query: string,
  none?: string,
  noneFacts = "",
): SpadeModelGroup[] {
  const typed = query.trim();
  const groups: SpadeModelGroup[] = [];
  if (none !== undefined && (!typed || matches(typed, none)))
    groups.push({
      label: undefined,
      options: [{ value: "", name: none, source: undefined, facts: noneFacts }],
    });
  const endpoints = spadeLocalFirst(sources.endpoints, (each) => each.endpoint.local);
  for (const { endpoint, models } of endpoints) {
    const options: SpadeModelOption[] = models
      .filter((model) => !typed || matches(typed, model.name, model.id, endpoint.name))
      .map((model) => ({
        value: `${endpoint.id}/${model.id}`,
        name: model.name,
        source: endpoint.name,
        facts: endpoint.local
          ? [spadeModelFacts(model), "Runs on this computer"].filter(Boolean).join(" · ")
          : spadeModelFacts(model),
      }));
    if (typed && !models.some((model) => model.id === typed))
      options.push({
        value: `${endpoint.id}/${typed}`,
        name: `Use “${typed}”`,
        source: endpoint.name,
        facts: "",
        typed: true,
      });
    if (options.length) groups.push({ label: endpoint.name, options });
  }
  const adds = (sources.adds ?? [])
    .filter(({ server, model }) => !typed || matches(typed, model, server.name))
    .map(({ server, model }) => ({
      value: `${server.id}/${model}`,
      name: model,
      source: server.name,
      facts: `${server.name} · Runs on this computer`,
      adds: { server: server.id, model },
    }));
  if (adds.length) groups.push({ label: "On this computer", options: adds });
  let heading: string | undefined = subscriptionsHeading;
  for (const source of sources.subscriptions) {
    const acknowledge = source.terms.acknowledged
      ? undefined
      : { provider: source.provider, text: source.terms.acknowledgement };
    const options = source.models
      .filter((model) => !typed || matches(typed, model.name, model.id, source.label))
      .map((model) => {
        const option: SpadeModelOption = {
          value: `${source.key}/${model.id}`,
          name: model.name,
          source: source.label,
          facts: "On your subscription",
        };
        if (acknowledge) option.acknowledge = acknowledge;
        return option;
      });
    if (!options.length) continue;
    groups.push({ label: source.label, ...(heading ? { heading } : {}), options });
    heading = undefined;
  }
  return groups;
}

/**
 * What the picker's button says for `value`: "Claude Sonnet 5.5 · OpenRouter", the empty
 * choice's words, or the saved id itself when no source lists it now.
 */
export function spadeModelLabel(
  sources: SpadeModelSources,
  value: string,
  none?: string,
): { name: string; source: string | undefined } {
  if (!value) return { name: none ?? "Choose a model", source: undefined };
  const cli = splitCliModel(value);
  if (cli) {
    const source = sources.subscriptions.find((each) => value.startsWith(`${each.key}/`));
    const model = source?.models.find((each) => each.id === cli.model);
    return { name: model?.name ?? cli.model, source: source?.label ?? cli.provider };
  }
  const { endpoint: id, model } = splitSpadeModel(value);
  const found = sources.endpoints.find((each) => each.endpoint.id === id);
  const info = found?.models.find((each) => each.id === model);
  return { name: info?.name ?? model, source: found?.endpoint.name ?? (id || undefined) };
}

/**
 * The words of a new bot's empty model choice: the first usable model (the picker names it
 * beside), or that none is set up yet.
 */
export const firstUsableWords = (model: string | undefined) =>
  model ? "First usable model" : "No model set up yet";
