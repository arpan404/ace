import { matchProfile, selectorRequest, sessionSelectors } from "@ace/agent-registry";
import type { ModelInstance } from "./types.ts";
import { z } from "zod";

/** The bounded number of models a probe asks about; agents list a handful. */
const probeLimit = 16;

type Request = (method: string, params: Record<string, string>) => Promise<unknown>;

const Loose = z.record(z.string(), z.unknown());
function record(value: unknown): Record<string, unknown> {
  return Loose.safeParse(value).data ?? {};
}

/**
 * An ACP session reports option sets (thinking level and the like) only for its current model.
 * Selects each other listed model on the probe session and records the options it then reports,
 * as that model's own `configOptions`, then selects the model that was current again. Selecting
 * a model is configuration only: no prompt is sent and no quota is spent. A model the agent
 * refuses keeps no options; only a refused return to the current model fails the probe.
 *
 * Some agents keep a selection beyond the session (Cursor saves its model for every later run,
 * `docs/research/providers/cursor.md`), so only an agent whose caller knows a selection is
 * undone by selecting again may be probed this way (`perModelProbe`).
 */
export async function withPerModelOptions(session: unknown, request: Request): Promise<unknown> {
  const payload = record(session);
  const sessionId = payload["sessionId"];
  const configs = payload["configOptions"];
  if (typeof sessionId !== "string" || !Array.isArray(configs)) return session;
  let selectors;
  try {
    selectors = sessionSelectors(session, undefined, true);
  } catch {
    return session;
  }
  const model = selectors.model;
  if (!model?.configId || model.method !== "session/set_config_option") return session;
  const at = configs.findIndex((config) => record(config)["id"] === model.configId);
  const config = record(configs[at]);
  const current = config["currentValue"];
  const options = config["options"];
  if (!Array.isArray(options) || options.some((option) => "options" in record(option)))
    return session;
  if (typeof current !== "string" || !model.values.includes(current)) return session;
  const learned = new Map<string, unknown[]>();
  let switched = false;
  for (const value of model.values.slice(0, probeLimit)) {
    if (value === current) continue;
    switched = true;
    try {
      const reply = record(await request(...requestOf(selectors, value, sessionId)));
      const reported = reply["configOptions"];
      if (Array.isArray(reported)) learned.set(value, reported);
    } catch {
      // An agent that refuses the switch leaves that model without options of its own.
    }
  }
  // The agent's own choice is left as the probe found it, whatever it kept of the switches.
  if (switched) await request(...requestOf(selectors, current, sessionId));
  if (!learned.size) return session;
  const probed = options.map((option) => {
    const entry = record(option);
    const value = entry["value"];
    const own = typeof value === "string" ? learned.get(value) : undefined;
    return own ? Object.assign({}, entry, { configOptions: own }) : option;
  });
  const next = [...configs];
  next[at] = { ...config, options: probed };
  return { ...payload, configOptions: next };
}

/**
 * Which agents the probe may switch models on: Antigravity, whose levels differ per model and
 * which reports them only for the current one. It runs as its own provider. Generic ACP agents
 * (Cursor among them) may keep a switch, so they list the current model's levels only.
 */
export function perModelProbe(provider: string): boolean {
  return provider === "antigravity";
}

function requestOf(
  selectors: ReturnType<typeof sessionSelectors>,
  value: string,
  sessionId: string,
): [string, Record<string, string>] {
  const { method, params } = selectorRequest(selectors, "model", value, sessionId);
  return [method, params];
}

/**
 * Whether a probe may go on to `session/new` after the agent's `initialize` reply. A row that
 * loads unasked (a reviewed profile, `modelProbe: "automatic"`) may only while the version the
 * agent reports still has that profile: an agent that updated itself past it is not the one
 * ace reviewed. An unprofiled row, and a reply without a version, go on.
 */
export function negotiatedProbeAllowed(
  instance: Pick<
    ModelInstance,
    "provider" | "modelProbe" | "acpAgentId" | "installationVersion" | "profileRevision"
  >,
  initialized: unknown,
): boolean {
  if (instance.provider !== "acp" || instance.modelProbe !== "automatic") return true;
  const version = record(record(initialized)["agentInfo"])["version"];
  if (typeof version !== "string" || version === instance.installationVersion) return true;
  const agent = instance.acpAgentId?.startsWith("official:") ? instance.acpAgentId.slice(9) : "";
  return agent !== "" && matchProfile(agent, version)?.revision === instance.profileRevision;
}
