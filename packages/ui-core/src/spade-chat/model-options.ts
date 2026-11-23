import {
  spadeLocalFirst,
  spadeModelFacts,
  type SpadeEndpoint,
  type SpadeModelInfo,
} from "./endpoints.ts";
import { spadeAccountLabels } from "./accounts.ts";
import { splitSpadeModel } from "./agents.ts";
import {
  spadeCantRunBots,
  spadeChecking,
  spadeNoToolsShort,
  spadeWorksWell,
} from "./model-checks.ts";

/*
 * What the one model picker offers, as plain data, in the order Spade offers models (ADR 0205
 * §1): models on this computer, the person's other endpoints, then local servers' models not
 * added yet. Grouped by where each comes from and narrowed by what the person typed. Pure, so
 * each client's picker only draws it.
 */

export interface SpadeModelOption {
  /** `endpoint/model`, or "" for the picker's empty choice. */
  value: string;
  name: string;
  /** The endpoint it comes from; undefined for the empty choice. */
  source: string | undefined;
  facts: string;
  /** "Use … as the model id": a typed id the endpoint didn't list. */
  typed?: boolean;
  /** A local server's model not added yet: picking it adds the server first. */
  adds?: { server: string; model: string };
  /** Why it can't be picked here: a local model that can't run a bot (ADR 0205 §3). */
  cant?: string;
}

export interface SpadeModelGroup {
  /** The group's label; undefined for the empty choice, above every group. */
  label: string | undefined;
  options: SpadeModelOption[];
}

export interface SpadeModelSources {
  /** Each endpoint with the models it offers now (saved and live, merged). */
  endpoints: readonly { endpoint: SpadeEndpoint; models: readonly SpadeModelInfo[] }[];
  /** Models of servers running on this computer that aren't added yet. */
  adds?: readonly { server: { id: string; name: string }; model: string }[];
  /** The model runs a bot (its own model, a tool role): one that can't call tools can't be picked. */
  forBots?: boolean;
}

const matches = (query: string, ...words: string[]) =>
  words.join(" ").toLowerCase().includes(query.toLowerCase());

/**
 * The picker's groups for `query`: the empty choice when there is one (`none`), then one group
 * per endpoint (those on this computer first), then the local servers' models not added yet. A
 * typed id no endpoint lists is offered on each endpoint, last in its group.
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
  // Two accounts of one name are told apart by their ids (ADR 0214).
  const labels = spadeAccountLabels(endpoints.map((each) => each.endpoint));
  for (const { endpoint, models } of endpoints) {
    const label = labels.get(endpoint.id) ?? endpoint.name;
    const options: SpadeModelOption[] = models
      .filter((model) => !typed || matches(typed, model.name, model.id, label))
      .map((model) => {
        const option: SpadeModelOption = {
          value: `${endpoint.id}/${model.id}`,
          name: model.name,
          source: label,
          facts: endpoint.local
            ? [model.knownGood ? spadeWorksWell : spadeModelFacts(model), "Runs on this computer"]
                .filter(Boolean)
                .join(" · ")
            : spadeModelFacts(model),
        };
        const cant = sources.forBots ? spadeCantRunBots(model) : undefined;
        if (cant) {
          option.cant = cant;
          option.facts = model.checks?.tools === "failed" ? spadeNoToolsShort : cant;
        }
        return option;
      });
    if (typed && !models.some((model) => model.id === typed))
      options.push({
        value: `${endpoint.id}/${typed}`,
        name: `Use “${typed}”`,
        source: label,
        facts: "",
        typed: true,
      });
    if (options.length) groups.push({ label, options });
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
  const { endpoint: id, model } = splitSpadeModel(value);
  const found = sources.endpoints.find((each) => each.endpoint.id === id);
  const info = found?.models.find((each) => each.id === model);
  return {
    name: info?.name ?? spadeModelWords(model),
    source: found
      ? spadeAccountLabels(sources.endpoints.map((each) => each.endpoint)).get(found.endpoint.id)
      : id || undefined,
  };
}

/**
 * A saved model id no source lists now, in words: its last path part with dashes as spaces
 * ("saved/model" reads "Model"), never the id itself.
 */
export function spadeModelWords(id: string): string {
  const last = id.split("/").findLast((part) => part !== "") ?? id;
  const words = last.replaceAll(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : id;
}

/**
 * The words of a new bot's empty model choice: the first usable model (the picker names it
 * beside), or that none is set up yet.
 */
export const spadeFirstUsableWords = (model: string | undefined) =>
  model ? "First usable model" : "No model set up yet";

/**
 * Why a local model just added can't run a bot, once Spade's checks on it end (ADR 0205 §3):
 * reads the person's models with `read` each second until they say, for at most `most` reads.
 * Undefined when it can.
 */
export async function spadeWaitForChecks(
  value: string,
  read: () => Promise<{ endpoints: readonly SpadeEndpoint[] }>,
  most = 400,
  wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
): Promise<string | undefined> {
  const { endpoint: id, model } = splitSpadeModel(value);
  for (let tries = 0; tries < most; tries += 1) {
    const { endpoints } = await read();
    const info = endpoints.find((each) => each.id === id)?.models.find((each) => each.id === model);
    const cant = info ? spadeCantRunBots(info) : spadeChecking;
    if (cant !== spadeChecking) return cant;
    await wait(1000);
  }
  return spadeChecking;
}
