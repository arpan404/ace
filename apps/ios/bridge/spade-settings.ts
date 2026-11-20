import type { ClientCore } from "@ace/client";
import {
  parseSpadeConnectors,
  parseSpadeModels,
  parseSpadeSearchSettings,
  parseSpadeSkillStore,
  parseSpadeSubscriptions,
  spadePresetChoices,
  spadeSetupSentence,
  spadeSubscriptionSources,
  type SpadeModelSources,
  type SpadeModels,
} from "@ace/ui-core/spade-chat";
import { z } from "zod";
import { spadePlaceLine } from "./spade-rows.ts";
import {
  spadeAppsPage,
  spadeModelChoices,
  spadeModelRoles,
  spadeModelSetting,
  spadeModelsPage,
  spadeSearchPage,
  type SpadeAppsPageRow,
  type SpadeModelGroupRow,
  type SpadeModelSettingRow,
  type SpadeModelsPageRow,
  type SpadeSearchPageRow,
} from "./spade-settings-rows.ts";
import { segment, type NativeSpade } from "./spade.ts";

/*
 * Settings › Spade from the phone: each page read afresh, and each change written to Spade and
 * answered with the page as it now is. A key the person types travels once, to Spade, which
 * keeps it in the machine's keychain (ADR 0119); no answer carries it back.
 */

const id = z.string().min(1).max(256);
const model = z.string().min(1).max(512).nullable();
/** A key as pasted: no API key is near this long, and none is empty. */
const key = z.string().trim().min(1).max(8_192);

export const spadeSettingsRequests = [
  z.object({
    type: z.literal("spade.settings.read"),
    page: z.enum(["general", "models", "search", "apps"]),
  }),
  /** Run Spade on this machine, or stop it: the global setting, admin only. */
  z.object({ type: z.literal("spade.settings.run"), on: z.boolean() }),
  z.object({ type: z.literal("spade.settings.model"), role: z.enum(spadeModelRoles), model }),
  /** An endpoint's key to keep (sent once), or null to remove it. */
  z.object({ type: z.literal("spade.settings.key"), endpoint: id, key: key.nullable() }),
  z.object({ type: z.literal("spade.settings.endpoint.add"), preset: id }),
  z.object({ type: z.literal("spade.settings.endpoint.remove"), endpoint: id }),
  z.object({
    type: z.literal("spade.settings.searxng"),
    url: z.string().trim().max(2_048).nullable(),
  }),
  z.object({ type: z.literal("spade.settings.brave"), key: key.nullable() }),
  z.object({ type: z.literal("spade.settings.disconnect"), connector: id }),
] as const;
export const NativeSpadeSettingsRequest = z.discriminatedUnion("type", spadeSettingsRequests);
export type NativeSpadeSettingsRequest = z.infer<typeof NativeSpadeSettingsRequest>;

export interface SpadeGeneralPageRow {
  run: { on: boolean | null; line: string | null };
  /** Empty while Spade isn't running: there is nothing to ask. */
  models: SpadeModelSettingRow[];
  groups: SpadeModelGroupRow[];
  more: number;
}

type Line = ReturnType<typeof spadePlaceLine>;
type Refusal = { ok: false; title: string; message: string };
export type SpadeSettingsAnswer =
  | Refusal
  | ({ ok: true; line: Line } & (
      | { general: SpadeGeneralPageRow }
      | { models: SpadeModelsPageRow }
      | { search: SpadeSearchPageRow }
      | { apps: SpadeAppsPageRow }
      | Record<never, never>
    ));

type Ask = (
  method: "GET" | "POST" | "PUT" | "DELETE",
  route: string,
  body?: unknown,
) => Promise<string>;

const refused = (title: string, error: unknown): Refusal => ({
  ok: false,
  title,
  message: (error instanceof Error && error.message) || "Try again.",
});

function sure<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Spade's ${what} didn't make sense.`);
  return value;
}

/** `GET /v1/models`, and where each model the pickers offer comes from. */
export async function readModelSources(
  ask: Ask,
): Promise<{ models: SpadeModels; sources: SpadeModelSources }> {
  const [models, subscriptions] = await Promise.all([
    ask("GET", "/v1/models").then((body) => sure(parseSpadeModels(body), "models")),
    // Subscriptions are ace's to list; while ace can't say, the endpoints still show.
    ask("GET", "/v1/subscriptions").then(
      (body) => parseSpadeSubscriptions(body)?.providers ?? [],
      () => [],
    ),
  ]);
  const sources = {
    endpoints: models.endpoints.map((endpoint) => ({ endpoint, models: endpoint.models })),
    subscriptions: spadeSubscriptionSources(subscriptions),
  };
  return { models, sources };
}

export async function answerSpadeSettings(
  owner: ClientCore,
  spade: NativeSpade,
  request: NativeSpadeSettingsRequest,
  deps: { now(): number },
  ask: Ask,
  signal: AbortSignal,
): Promise<SpadeSettingsAnswer> {
  const page = (name: "general" | "models" | "search" | "apps") =>
    readPage(spade, name, ask, deps.now());
  const write = async (
    title: string,
    change: () => Promise<unknown>,
    then: Parameters<typeof page>[0],
  ) => {
    try {
      await change();
    } catch (error) {
      return refused(title, error);
    }
    return page(then);
  };
  switch (request.type) {
    case "spade.settings.read":
      return page(request.page);
    case "spade.settings.run": {
      const outcome = await setRunning(owner, spade, request.on, signal);
      return outcome.ok ? page("general") : outcome;
    }
    case "spade.settings.model":
      return write(
        "Couldn't change the model",
        () => ask("PUT", "/v1/settings", { [`${request.role}_model`]: request.model }),
        "general",
      );
    case "spade.settings.key": {
      const route = `/v1/keys/${segment(request.endpoint)}`;
      return request.key === null
        ? write("Couldn't remove the key", () => ask("DELETE", route), "models")
        : write("Couldn't keep the key", () => ask("PUT", route, { key: request.key }), "models");
    }
    case "spade.settings.endpoint.add":
      return write("Couldn't add it", () => addFromPreset(ask, request.preset), "models");
    case "spade.settings.endpoint.remove":
      return write(
        "Couldn't remove it",
        () => ask("DELETE", `/v1/endpoints/${segment(request.endpoint)}`),
        "models",
      );
    case "spade.settings.searxng":
      return write(
        "Couldn't save the address",
        () => ask("PUT", "/v1/search", { searxng_url: request.url || null }),
        "search",
      );
    case "spade.settings.brave":
      return request.key === null
        ? write("Couldn't remove the key", () => ask("DELETE", "/v1/search/brave-key"), "search")
        : write(
            "Couldn't keep the key",
            () => ask("PUT", "/v1/search/brave-key", { key: request.key }),
            "search",
          );
    case "spade.settings.disconnect":
      return write(
        "Couldn't disconnect it",
        () => ask("DELETE", `/v1/connectors/${segment(request.connector)}`),
        "apps",
      );
  }
}

/** An endpoint as a preset describes it; its key is set on its own, once it is added. */
async function addFromPreset(ask: Ask, id: string) {
  const models = sure(parseSpadeModels(await ask("GET", "/v1/models")), "models");
  const choice = spadePresetChoices(models.presets).find((each) => each.preset.id === id);
  const preset = choice?.preset;
  if (!choice || !preset?.format)
    throw new Error("This machine's Spade doesn't offer that service any more.");
  await ask("POST", "/v1/endpoints", {
    name: choice.label,
    format: preset.format,
    base_url: preset.baseUrl,
    preset: preset.id,
    ...(preset.sessionHeader ? { session_header: preset.sessionHeader } : {}),
  });
}

async function readPage(
  spade: NativeSpade,
  name: "general" | "models" | "search" | "apps",
  ask: Ask,
  now: number,
): Promise<SpadeSettingsAnswer> {
  const { status, enabled } = spade.setting;
  const line = spadePlaceLine(status, enabled);
  if (name === "general" && !line.ready) {
    const run = { on: enabled ?? null, line: enabled === false ? null : line.sentence };
    return { ok: true, line, general: { run, models: [], groups: [], more: 0 } };
  }
  // The other pages need Spade answering: the phone says why it isn't, once.
  if (!line.ready) return { ok: true, line };
  try {
    switch (name) {
      case "general": {
        const { models, sources } = await readModelSources(ask);
        const run = { on: enabled ?? null, line: (status && spadeSetupSentence(status)) ?? null };
        const rows = spadeModelRoles.map((role) => spadeModelSetting(role, models, sources));
        return { ok: true, line, general: { run, models: rows, ...spadeModelChoices(sources) } };
      }
      case "models": {
        const models = sure(parseSpadeModels(await ask("GET", "/v1/models")), "models");
        return { ok: true, line, models: spadeModelsPage(models) };
      }
      case "search": {
        const search = sure(parseSpadeSearchSettings(await ask("GET", "/v1/search")), "web search");
        return { ok: true, line, search: spadeSearchPage(search) };
      }
      case "apps": {
        const [connectors, store] = await Promise.all([
          ask("GET", "/v1/connectors").then((body) => sure(parseSpadeConnectors(body), "apps")),
          // Skills show when Spade lists them; the apps show without.
          ask("GET", "/v1/skills").then(parseSpadeSkillStore, () => undefined),
        ]);
        const apps = spadeAppsPage(connectors.connectors, store, spade.names, now);
        return { ok: true, line, apps };
      }
    }
  } catch (error) {
    return refused("Couldn't read Spade's settings", error);
  }
}

/** `spade.enabled` is global and admin only: a device without admin is told so. */
export async function setRunning(
  owner: ClientCore,
  spade: NativeSpade,
  on: boolean,
  signal: AbortSignal,
): Promise<{ ok: true } | Refusal> {
  const reply = await owner
    .request(
      { type: "settings.set", key: "spade.enabled", value: on, layer: { kind: "global" } },
      { signal, timeoutMs: 10_000 },
    )
    .catch(() => undefined);
  if (reply?.ok) spade.enabledNow(on);
  spade.refresh();
  if (reply?.ok) return { ok: true };
  return {
    ok: false,
    title: on ? "Couldn't turn on Spade" : "Couldn't turn off Spade",
    message: "Only a device with admin access to this machine can change it.",
  };
}
