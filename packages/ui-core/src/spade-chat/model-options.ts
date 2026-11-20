import { spadeModelFacts, type SpadeEndpoint, type SpadeModelInfo } from "./endpoints.ts";
import { splitSpadeModel } from "./agents.ts";
import { splitCliModel, type SpadeSubscriptionSource } from "./subscriptions.ts";

/*
 * What the one model picker offers, as plain data: every model of every endpoint and
 * subscription, grouped by where it comes from, narrowed by what the person typed. Pure, so each
 * client's picker only draws it.
 */

export interface SpadeModelOption {
  /** `endpoint/model`, `cli:<provider>@<account>/<model>`, or "" for the picker's empty choice. */
  value: string;
  name: string;
  /** The endpoint or subscription it comes from; undefined for the empty choice. */
  source: string | undefined;
  facts: string;
  /** "Use … as the model id": a typed id the endpoint didn't list. */
  typed?: boolean;
}

export interface SpadeModelGroup {
  /** The group's label; undefined for the empty choice, above every group. */
  label: string | undefined;
  options: SpadeModelOption[];
}

export interface SpadeModelSources {
  /** Each endpoint with the models it offers now (saved and live, merged). */
  endpoints: readonly { endpoint: SpadeEndpoint; models: readonly SpadeModelInfo[] }[];
  subscriptions: readonly SpadeSubscriptionSource[];
}

const matches = (query: string, ...words: string[]) =>
  words.join(" ").toLowerCase().includes(query.toLowerCase());

/**
 * The picker's groups for `query`: the empty choice when there is one (`none`), then one group
 * per endpoint, then one per subscription. A typed id no endpoint lists is offered on each
 * endpoint, last in its group.
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
  for (const { endpoint, models } of sources.endpoints) {
    const options: SpadeModelOption[] = models
      .filter((model) => !typed || matches(typed, model.name, model.id, endpoint.name))
      .map((model) => ({
        value: `${endpoint.id}/${model.id}`,
        name: model.name,
        source: endpoint.name,
        facts: spadeModelFacts(model),
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
  for (const source of sources.subscriptions) {
    const options = source.models
      .filter((model) => !typed || matches(typed, model.name, model.id, source.label))
      .map((model) => ({
        value: `${source.key}/${model.id}`,
        name: model.name,
        source: source.label,
        facts: "",
      }));
    if (options.length) groups.push({ label: source.label, options });
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
export const spadeFirstUsableWords = (model: string | undefined) =>
  model ? "First usable model" : "No model set up yet";
