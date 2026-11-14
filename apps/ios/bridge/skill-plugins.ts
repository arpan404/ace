import { ClientError, type ClientCore } from "@ace/client";
import { PluginName, ProviderKind, PluginRequest, type PluginResponse } from "@ace/protocol";
import {
  emptyMarketplaceText,
  pluginAgentSet,
  pluginAgentsText,
  PluginNameInput,
  pluginOn,
  PluginRef,
  PluginRepository,
  pluginSwitched,
  providerNames,
  sourceText,
  suggestedPluginName,
  unreadMarketplaceText,
  type PluginPolicy,
} from "@ace/ui-core";
import { z } from "zod";

/*
 * Which coding agents an installed plugin reaches, for the phone: each plugin's line ("On for
 * Claude Code and Codex"), and switching it, or one agent, on or off for the whole plugin. The
 * rules are `@ace/ui-core`'s, the web's plugin page's too.
 *
 * The daemon takes a plugin's whole policy at once, so each change starts from the policy the
 * daemon holds now, and changes to one plugin run one after another: two quick taps can't
 * overwrite each other with an older list.
 *
 * Installing starts here too: Find plugins reads a repository's marketplace for the person to
 * pick from (or, when it can't be read, takes the name typed), and the choice is checked and
 * written as `plugins.prepare` takes it, as the web's install dialog does.
 */

export const NativePluginsRequest = z.discriminatedUnion("op", [
  z.object({ type: z.literal("plugins.native"), op: z.literal("plugins") }),
  z.object({
    type: z.literal("plugins.native"),
    op: z.literal("switch"),
    name: PluginName,
    enabled: z.boolean(),
  }),
  z.object({
    type: z.literal("plugins.native"),
    op: z.literal("agent"),
    name: PluginName,
    provider: ProviderKind,
    on: z.boolean(),
  }),
  z.object({
    type: z.literal("plugins.native"),
    op: z.literal("find"),
    repository: z.string().max(4096),
    ref: z.string().max(256),
  }),
  z.object({
    type: z.literal("plugins.native"),
    op: z.literal("source"),
    repository: z.string().max(4096),
    ref: z.string().max(256),
    name: z.string().max(256),
  }),
]);
export type NativePluginsRequest = z.infer<typeof NativePluginsRequest>;

type Owner = Pick<ClientCore, "request">;
const wait = { timeoutMs: 20_000 };
const unreachable = "Couldn't reach the machine. Nothing changed; try again.";
/** A refusal said as it is, never as a lost connection. */
class Refused extends Error {}

async function plugin<T extends PluginResponse["type"]>(
  owner: Owner,
  request: z.input<typeof PluginRequest>,
  expected: T,
  signal: AbortSignal,
): Promise<Extract<PluginResponse, { type: T }>> {
  const reply = await owner.request({ type: "pluginRequest", request }, { ...wait, signal });
  if (reply.response.type !== expected) throw new Error("The machine answered something else.");
  return reply.response as Extract<PluginResponse, { type: T }>;
}

function view(name: string, version: string, policy: PluginPolicy, source: string | null) {
  return {
    name,
    version,
    source,
    on: pluginOn(policy),
    enabled: policy.enabled,
    summary: pluginAgentsText(policy),
    agents: ProviderKind.options.map((provider) => ({
      id: provider,
      name: providerNames[provider],
      on: policy.providers.includes(provider),
    })),
  };
}

export class NativeSkillPlugins {
  readonly #owner: Owner;
  readonly #queues = new Map<string, Promise<unknown>>();
  constructor(owner: Owner) {
    this.#owner = owner;
  }

  async answer(request: NativePluginsRequest, signal: AbortSignal): Promise<unknown> {
    try {
      if (request.op === "plugins") return { ok: true, plugins: await this.#plugins(signal) };
      if (request.op === "find") return { ok: true, ...(await this.#find(request, signal)) };
      if (request.op === "source") return { ok: true, prepare: checkedSource(request) };
      return {
        ok: true,
        plugin: await this.#queued(request.name, () => this.#change(request, signal)),
      };
    } catch (error) {
      if (error instanceof Refused) return { ok: false, message: error.message };
      return {
        ok: false,
        message: request.op === "plugins" ? "Couldn't read your plugins." : unreachable,
      };
    }
  }

  async #plugins(signal: AbortSignal) {
    const list = await plugin(this.#owner, { type: "plugins.list" }, "plugins.list", signal);
    // One plugin request at a time (the daemon refuses a second), and a daemon that predates
    // `plugins.origins` simply doesn't say where plugins came from.
    const origins = await plugin(
      this.#owner,
      { type: "plugins.origins" },
      "plugins.origins",
      signal,
    )
      .then((reply) => reply.origins)
      .catch(() => []);
    const from = new Map(origins.map((origin) => [origin.name, origin]));
    const policies = new Map((list.availability ?? []).map((each) => [each.name, each]));
    return list.installs
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((install) => {
        const origin = from.get(install.name);
        return view(
          install.name,
          install.version,
          policies.get(install.name) ?? everyAgent,
          origin ? sourceText(origin.repository, origin.ref) : null,
        );
      });
  }

  /** What the repository's marketplace offers; when it can't be read, the name is typed. */
  async #find(request: Extract<NativePluginsRequest, { op: "find" }>, signal: AbortSignal) {
    const { repository, ref } = checkedPlace(request);
    try {
      const listed = await plugin(
        this.#owner,
        { type: "plugins.marketplace", repository, ...(ref ? { ref } : {}) },
        "plugins.marketplace",
        signal,
      );
      const only = listed.plugins.length === 1 ? listed.plugins[0]?.name : undefined;
      return {
        repository,
        ref: listed.ref,
        from: sourceText(repository, listed.ref),
        plugins: listed.plugins.map((each) => ({
          name: each.name,
          version: each.version ?? null,
          description: each.description ?? null,
        })),
        picked: only ?? null,
        manual: false,
        note: listed.plugins.length ? null : emptyMarketplaceText,
      };
    } catch (error) {
      // Only a refusal falls back to typing the name; a lost connection says so. The client
      // keeps a refusal's code, not its sentence, so the shared one is said.
      if (!(error instanceof ClientError) || error.code !== "daemon") throw error;
      return {
        repository,
        ref: ref ?? "HEAD",
        from: sourceText(repository, ref),
        plugins: [],
        picked: suggestedPluginName(request.repository) || null,
        manual: true,
        note: unreadMarketplaceText,
      };
    }
  }

  async #change(
    request: Extract<NativePluginsRequest, { op: "switch" | "agent" }>,
    signal: AbortSignal,
  ) {
    const current = (await this.#plugins(signal)).find((each) => each.name === request.name);
    if (!current) throw new Refused("That plugin isn't installed any more.");
    const policy: PluginPolicy = {
      enabled: current.enabled,
      providers: current.agents.filter((agent) => agent.on).map((agent) => agent.id),
    };
    const next =
      request.op === "switch"
        ? pluginSwitched(policy, request.enabled)
        : pluginAgentSet(policy, request.provider, request.on);
    const saved = await plugin(
      this.#owner,
      {
        type: "plugins.availability",
        name: request.name,
        enabled: next.enabled,
        providers: [...next.providers],
      },
      "plugins.availability",
      signal,
    );
    return view(request.name, current.version, saved.availability, current.source);
  }

  /** Runs `change` after every earlier change to the same plugin has settled. */
  #queued<T>(name: string, change: () => Promise<T>): Promise<T> {
    const before = this.#queues.get(name) ?? Promise.resolve();
    const run = before.then(change, change);
    const settled = run.catch(() => undefined);
    this.#queues.set(name, settled);
    void settled.then(() => {
      if (this.#queues.get(name) === settled) this.#queues.delete(name);
    });
    return run;
  }
}

const everyAgent: PluginPolicy = { enabled: true, providers: ProviderKind.options };

/** The repository and ref as typed, checked and written as the daemon fetches them. */
function checkedPlace(request: { repository: string; ref: string }) {
  const repository = PluginRepository.safeParse(request.repository);
  if (!repository.success) throw new Refused(firstIssue(repository.error));
  if (!request.ref.trim()) return { repository: repository.data, ref: undefined };
  const ref = PluginRef.safeParse(request.ref);
  if (!ref.success) throw new Refused(firstIssue(ref.error));
  return { repository: repository.data, ref: ref.data };
}

/** The plugin chosen from a source, as `plugins.prepare` takes it, or the reason it can't be. */
function checkedSource(request: Extract<NativePluginsRequest, { op: "source" }>) {
  const { repository, ref } = checkedPlace(request);
  const name = PluginNameInput.safeParse(request.name);
  if (!name.success) throw new Refused(firstIssue(name.error));
  return { type: "plugins.prepare", repository, ref: ref ?? "HEAD", name: name.data };
}

const firstIssue = (error: z.ZodError) => error.issues[0]?.message ?? "Check what you typed.";
