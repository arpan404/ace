import type { ClientCore } from "@ace/client";
import { PluginName, ProviderKind, PluginRequest, type PluginResponse } from "@ace/protocol";
import {
  pluginAgentSet,
  pluginAgentsText,
  pluginOn,
  pluginSwitched,
  providerNames,
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

function view(name: string, version: string, policy: PluginPolicy) {
  return {
    name,
    version,
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
      return { ok: true, plugin: await this.#queued(request.name, () => this.#change(request, signal)) };
    } catch (error) {
      if (error instanceof Refused) return { ok: false, message: error.message };
      return { ok: false, message: request.op === "plugins" ? "Couldn't read your plugins." : unreachable };
    }
  }

  async #plugins(signal: AbortSignal) {
    const list = await plugin(this.#owner, { type: "plugins.list" }, "plugins.list", signal);
    const policies = new Map((list.availability ?? []).map((each) => [each.name, each]));
    return list.installs
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((install) =>
        view(install.name, install.version, policies.get(install.name) ?? everyAgent),
      );
  }

  async #change(request: Exclude<NativePluginsRequest, { op: "plugins" }>, signal: AbortSignal) {
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
      { type: "plugins.availability", name: request.name, enabled: next.enabled, providers: [...next.providers] },
      "plugins.availability",
      signal,
    );
    return view(request.name, current.version, saved.availability);
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
