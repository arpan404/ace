import { selectorRequest, sessionSelectors } from "@ace/agent-registry";
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
 * as that model's own `configOptions`. Selecting a model is configuration only: no prompt is
 * sent and no quota is spent. A model the agent refuses keeps no options; the probe never fails.
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
  const learned = new Map<string, unknown[]>();
  for (const value of model.values.slice(0, probeLimit)) {
    if (value === current) continue;
    try {
      const reply = record(await request(...requestOf(selectors, value, sessionId)));
      const reported = reply["configOptions"];
      if (Array.isArray(reported)) learned.set(value, reported);
    } catch {
      // An agent that refuses the switch leaves that model without options of its own.
    }
  }
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

function requestOf(
  selectors: ReturnType<typeof sessionSelectors>,
  value: string,
  sessionId: string,
): [string, Record<string, string>] {
  const { method, params } = selectorRequest(selectors, "model", value, sessionId);
  return [method, params];
}
